// Logging in with a FAF account, for the Chat tab.
//
// The browser runs FAF's login itself (authorization code with PKCE, a public
// OAuth client without a secret). Hydra and FAF's user service answer no CORS
// requests, so the follow-up calls go through this site's /api/auth routes
// (lib/userlogin.js), which hand back only what the chat needs: who logged
// in, a chat token valid for a day, and a refresh token for the next one.
//
// What is kept in the browser (localStorage, this site only): the user's name
// and id, the chat token, the refresh token, and the ticket for the PC link
// (link/link.ts). No password ever passes through this site: it is typed on
// FAF's own login page.

export interface SessionUser {
  id: string;
  name: string;
}

export interface Session {
  user: SessionUser;
  chatToken: string;
  /** When the chat token was handed out (ms). FAF's chat tokens live 24 hours. */
  chatTokenAt: number;
  refreshToken: string | null;
  /** This site's pass to the PC link, handed out with each chat token. */
  linkTicket?: string;
}

export interface SiteConfig {
  /** faforever.com, or faforever.xyz on FAF's test servers. */
  baseDomain?: string;
  login: { clientId: string; authorizeUrl: string; scope: string; callbackPath: string } | null;
  chat: { url: string; channel: string } | null;
  /** The PC link (lib/link.js): its WebSocket path and the key push subscriptions are made for. */
  link?: { path: string; pushKey: string | null } | null;
}

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const SESSION_KEY = "faf-web.session";
const PENDING_KEY = "faf-web.login";
/** Renew the chat token this long before its 24 hours are up. */
const CHAT_TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000;

// ---- storage, which can be missing or throw (private windows, blocked storage)

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // Not kept: the visitor logs in again next time.
  }
}

const local = () => window.localStorage;
const sessionStore = () => window.sessionStorage;

// ---- session state, shared with every view that cares

let current: Session | null = parseSession(read(local, SESSION_KEY));
const listeners = new Set<() => void>();

function parseSession(text: string | null): Session | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Session;
    if (value && value.user && typeof value.user.name === "string" && typeof value.chatToken === "string") return value;
  } catch {
    // Unreadable: treated as logged out.
  }
  return null;
}

function setSession(next: Session | null) {
  current = next;
  write(local, SESSION_KEY, next ? JSON.stringify(next) : null);
  listeners.forEach((listener) => listener());
}

// Another tab logged in, out, or renewed the token.
window.addEventListener("storage", (event) => {
  if (event.key !== SESSION_KEY) return;
  current = parseSession(event.newValue);
  listeners.forEach((listener) => listener());
});

export function getSession(): Session | null {
  return current;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- site config

let configPromise: Promise<SiteConfig> | null = null;

export function siteConfig(): Promise<SiteConfig> {
  if (!configPromise) {
    configPromise = fetch("/api/config", { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<SiteConfig>) : { login: null, chat: null }))
      .catch(() => {
        configPromise = null;
        return { login: null, chat: null };
      });
  }
  return configPromise;
}

// ---- PKCE

function base64Url(bytes: Uint8Array): string {
  let text = "";
  bytes.forEach((b) => (text += String.fromCharCode(b)));
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function redirectUri(config: NonNullable<SiteConfig["login"]>): string {
  return window.location.origin + config.callbackPath;
}

/** Sends the visitor to FAF's login page. They come back to /auth/callback. */
export async function beginLogin(returnTo = "/chat"): Promise<void> {
  const config = (await siteConfig()).login;
  if (!config) throw new AuthError("login-off", "Login is not available on this site.");
  if (!window.crypto?.subtle) throw new AuthError("insecure", "Login needs a secure (https) connection.");

  const verifier = randomString(32);
  const state = randomString(16);
  write(sessionStore, PENDING_KEY, JSON.stringify({ verifier, state, returnTo }));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri(config),
    scope: config.scope,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  });
  window.location.assign(`${config.authorizeUrl}?${params.toString()}`);
}

// What the server's error codes (lib/userlogin.js) mean to the visitor.
const PROBLEMS: Record<string, string> = {
  "session-expired": "Your login has expired. Please log in again.",
  "login-rejected": "FAF did not accept the login. Please try again.",
  "login-unreachable": "FAF's login service did not answer. Try again in a moment.",
  "login-failed": "FAF's login service did not answer. Try again in a moment.",
  "chat-token-failed": "FAF did not hand out a chat login. Try again in a moment.",
  "login-off": "Login is switched off on this site.",
};

async function postAuth(action: "login" | "refresh", body: unknown): Promise<Session> {
  let res: Response;
  try {
    res = await fetch(`/api/auth/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("offline", "This site could not be reached.");
  }
  const data = (await res.json().catch(() => null)) as
    | { user?: SessionUser; chatToken?: string; refreshToken?: string | null; linkTicket?: string; code?: string; error?: string }
    | null;
  if (!res.ok || !data || !data.user || typeof data.chatToken !== "string") {
    const code = data?.code ?? "failed";
    throw new AuthError(code, PROBLEMS[code] ?? `Login failed (${res.status}).`);
  }
  return {
    user: data.user,
    chatToken: data.chatToken,
    chatTokenAt: Date.now(),
    refreshToken: data.refreshToken ?? null,
    linkTicket: typeof data.linkTicket === "string" ? data.linkTicket : undefined,
  };
}

/**
 * Finishes a login on /auth/callback. Returns where the visitor was going.
 * Throws AuthError with a reason the page can show.
 */
export async function completeLogin(search: string): Promise<string> {
  const params = new URLSearchParams(search);
  const pending = (() => {
    try {
      return JSON.parse(read(sessionStore, PENDING_KEY) ?? "null") as { verifier: string; state: string; returnTo: string } | null;
    } catch {
      return null;
    }
  })();
  write(sessionStore, PENDING_KEY, null);

  const error = params.get("error");
  if (error) {
    throw new AuthError(error, params.get("error_description") || (error === "access_denied" ? "The login was cancelled." : error));
  }
  const code = params.get("code");
  if (!code || !pending || params.get("state") !== pending.state) {
    throw new AuthError("stale", "This login link is no longer valid. Please log in again.");
  }
  const config = (await siteConfig()).login;
  if (!config) throw new AuthError("login-off", "Login is not available on this site.");

  setSession(await postAuth("login", { code, codeVerifier: pending.verifier, redirectUri: redirectUri(config) }));
  return pending.returnTo.startsWith("/") ? pending.returnTo : "/chat";
}

/**
 * A chat token that is still good, renewed through the refresh token when it
 * is old or is the one the chat just refused (`rejected`). Logs out when
 * renewal is refused.
 *
 * Hydra retires a refresh token once used, so two tabs renewing at the same
 * time would leave one of them with a dead token: the Web Locks API, where the
 * browser has it, lets only one tab renew while the other picks up its result.
 */
export async function freshChatToken(rejected?: string): Promise<Session> {
  const run = async () => {
    const session = parseSession(read(local, SESSION_KEY)) ?? current;
    if (!session) throw new AuthError("logged-out", "Not logged in.");
    const young = Date.now() - session.chatTokenAt < CHAT_TOKEN_MAX_AGE_MS;
    // Another tab may have renewed it while this one waited for the lock.
    if (young && session.chatToken !== rejected) {
      if (session !== current) setSession(session);
      return session;
    }
    if (!session.refreshToken) {
      setSession(null);
      throw new AuthError("session-expired", "Your login has expired. Please log in again.");
    }
    try {
      const next = await postAuth("refresh", { refreshToken: session.refreshToken });
      setSession(next);
      return next;
    } catch (err) {
      if (err instanceof AuthError && (err.code === "session-expired" || err.code === "bad-request")) setSession(null);
      throw err;
    }
  };
  const locks = (navigator as Navigator & { locks?: { request: <T>(name: string, fn: () => Promise<T>) => Promise<T> } }).locks;
  return locks ? locks.request("faf-web-session", run) : run();
}

/**
 * A ticket for the PC link. Renewed with the chat token; renewed early when the
 * server refused `rejected` (it restarted, or the login predates the link).
 */
export async function freshLinkTicket(rejected?: string): Promise<string> {
  let session = await freshChatToken();
  if (!session.linkTicket || session.linkTicket === rejected) {
    // Renewing early needs the refresh token; without one, forcing it would log the chat out too.
    if (!session.refreshToken) throw new AuthError("session-expired", "Log in again to reach your PC.");
    session = await freshChatToken(session.chatToken);
  }
  if (!session.linkTicket) throw new AuthError("link-off", "The PC link is not available on this site.");
  return session.linkTicket;
}

/** Forgets the login here and asks FAF to retire the refresh token. */
export function logout(): void {
  const session = current;
  setSession(null);
  if (session?.refreshToken) {
    void fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    }).catch(() => undefined);
  }
}
