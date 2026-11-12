// The PC link, browser side: one WebSocket to this site's /api/link, paired
// there with the FAF Rust client on the player's own PC (lib/link.js).
//
// It runs while somebody is logged in, on every tab, so a match found reaches
// the page whatever is open. A page left in the background stops after ten
// minutes unless a search is running, and picks up again when it is looked at.
//
// The browser can only ask for what lib/link.js lets through (a search, a
// stop, a join, a refresh), and the Rust client decides again, behind its own
// switch, which is off until the player turns it on.

import { useSyncExternalStore } from "react";
import { AuthError, freshLinkTicket, getSession, siteConfig, subscribeSession } from "../auth";
import { LINK_VERSION, type LinkCommand, type PcGame, type PcInfo, type PcState } from "./protocol";

export type LinkStatus = "off" | "logged-out" | "connecting" | "ready" | "failed";

export interface LinkSnapshot {
  status: LinkStatus;
  /** What went wrong, when `status` is "failed". */
  problem: string | null;
  pc: PcInfo;
  state: PcState | null;
  games: PcGame[] | null;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export interface LinkEvent {
  event: string;
  queue?: string;
}

const NO_PC: PcInfo = { connected: false };
const RETRY_SECONDS = [1, 2, 5, 10, 30];
const SLEEP_AFTER_HIDDEN_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15_000;

let snapshot: LinkSnapshot = { status: "logged-out", problem: null, pc: NO_PC, state: null, games: null };
const listeners = new Set<() => void>();
const eventListeners = new Set<(event: LinkEvent) => void>();

function update(patch: Partial<LinkSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLink(): LinkSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export function getLink(): LinkSnapshot {
  return snapshot;
}

/** Events the PC reports ("matchFound", ...). Returns the unsubscribe. */
export function onLinkEvent(listener: (event: LinkEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

// ---- the connection

let started = false;
let socket: WebSocket | null = null;
let opening = false;
let connectedAs: string | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let sleeping = false;
/** A ticket the server refused, so the next one is renewed first. */
let refusedTicket: string | undefined;
let ticketRenewed = false;
let seq = 0;
const pending = new Map<string, { resolve: (result: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>();

/** Starts the link for this page. Safe to call more than once. */
export function startLink(): void {
  if (started) return;
  started = true;
  subscribeSession(() => void reconcile());
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", () => void reconcile());
  void reconcile();
}

function searching(): boolean {
  const status = snapshot.state?.matchmaking.status;
  return status === "preparing" || status === "searching" || status === "matchFound" || status === "launching";
}

function onVisibility() {
  clearTimeout(hiddenTimer);
  if (document.hidden) {
    hiddenTimer = setTimeout(() => {
      if (!document.hidden || searching()) return;
      sleeping = true;
      drop();
    }, SLEEP_AFTER_HIDDEN_MS);
    return;
  }
  if (sleeping) {
    sleeping = false;
    void reconcile();
  }
}

/** Closes the socket without retrying. */
function drop() {
  clearTimeout(retryTimer);
  const ws = socket;
  socket = null;
  if (ws) ws.close(1000);
  failPending("The connection to this site closed.");
}

function failPending(error: string) {
  pending.forEach(({ resolve, timer }) => {
    clearTimeout(timer);
    resolve({ ok: false, error });
  });
  pending.clear();
}

async function reconcile() {
  const config = await siteConfig();
  if (!config.link) {
    drop();
    update({ status: "off", problem: null, pc: NO_PC, state: null, games: null });
    return;
  }
  const session = getSession();
  if (!session) {
    connectedAs = null;
    drop();
    update({ status: "logged-out", problem: null, pc: NO_PC, state: null, games: null });
    return;
  }
  // Logged in as somebody else (another tab): start over as them.
  if (connectedAs !== null && connectedAs !== session.user.id) {
    connectedAs = null;
    drop();
    update({ pc: NO_PC, state: null, games: null });
  }
  if (sleeping || socket || opening) return;
  void open(config.link.path);
}

function retryLater(seconds?: number) {
  clearTimeout(retryTimer);
  const wait = seconds ?? RETRY_SECONDS[Math.min(attempt, RETRY_SECONDS.length - 1)];
  attempt++;
  retryTimer = setTimeout(() => void reconcile(), wait * 1000);
}

async function open(path: string) {
  opening = true;
  if (snapshot.status !== "ready") update({ status: "connecting", problem: null });
  let ticket: string;
  try {
    ticket = await freshLinkTicket(refusedTicket);
  } catch (err) {
    opening = false;
    if (err instanceof AuthError && (err.code === "session-expired" || err.code === "logged-out" || err.code === "link-off")) {
      update({ status: "failed", problem: err.message });
      return;
    }
    update({ status: "failed", problem: "This site could not be reached. Trying again." });
    retryLater();
    return;
  }
  const session = getSession();
  if (!session) {
    opening = false;
    return;
  }

  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${scheme}//${window.location.host}${path}`);
  socket = ws;
  opening = false;
  connectedAs = session.user.id;
  let retry = true;

  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", role: "web", version: LINK_VERSION, ticket }));

  ws.onmessage = (message) => {
    if (socket !== ws) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(message.data));
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        attempt = 0;
        refusedTicket = undefined;
        ticketRenewed = false;
        update({ status: "ready", problem: null, pc: (msg.pc as PcInfo) ?? NO_PC });
        welcomeListeners.forEach((listener) => listener());
        return;
      case "pc": {
        const pc = (msg.pc as PcInfo) ?? NO_PC;
        update(pc.connected ? { pc } : { pc, state: null, games: null });
        return;
      }
      case "state":
        update({ state: msg.state as PcState });
        return;
      case "games":
        update({ games: Array.isArray(msg.games) ? (msg.games as PcGame[]) : null });
        return;
      case "event":
        if (typeof msg.event === "string") {
          const event: LinkEvent = { event: msg.event, queue: typeof msg.queue === "string" ? msg.queue : undefined };
          eventListeners.forEach((listener) => listener(event));
        }
        return;
      case "result": {
        const waiting = typeof msg.id === "string" ? pending.get(msg.id) : undefined;
        if (!waiting) return;
        pending.delete(msg.id as string);
        clearTimeout(waiting.timer);
        waiting.resolve({ ok: msg.ok === true, error: typeof msg.error === "string" ? msg.error : undefined });
        return;
      }
      case "error":
        if (msg.code === "ticket" && !ticketRenewed) {
          // The server restarted, or this login predates the link: one new ticket.
          refusedTicket = ticket;
          ticketRenewed = true;
          attempt = 0;
        } else if (msg.code === "too-many-browsers") {
          update({ status: "failed", problem: "This account is open in too many browsers. Close a few tabs." });
          retryLater(60);
          retry = false;
        } else {
          update({
            status: "failed",
            problem: msg.code === "version" ? "This page is out of date. Reload it." : String(msg.message || "The PC link refused this page."),
          });
          retry = false;
        }
        return;
      default:
    }
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    failPending("The connection to this site closed.");
    update({ pc: NO_PC, state: null, games: null });
    if (!retry) return;
    if (snapshot.status === "ready") update({ status: "connecting" });
    retryLater(attempt === 0 && ticketRenewed ? 0 : undefined);
  };
}

const welcomeListeners = new Set<() => void>();

/** Runs on every (re)connection, e.g. to sign the phone up for notifications again. */
export function onLinkWelcome(listener: () => void): () => void {
  welcomeListeners.add(listener);
  return () => welcomeListeners.delete(listener);
}

/** Ask the PC to do something. Resolves when the PC has accepted or refused it. */
export function sendCommand(command: LinkCommand): Promise<CommandResult> {
  const ws = socket;
  if (!ws || ws.readyState !== WebSocket.OPEN || snapshot.status !== "ready") {
    return Promise.resolve({ ok: false, error: "Not connected to this site." });
  }
  if (!snapshot.pc.connected) return Promise.resolve({ ok: false, error: "Your PC is not connected." });
  const id = `c${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "Your PC did not answer." });
    }, COMMAND_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ type: "command", id, command }));
  });
}

// ---- friends, for the Chat tab's roster and name colours

const NO_FRIENDS: ReadonlySet<string> = new Set();
let friendsFor: PcState | null = null;
let friendSet: ReadonlySet<string> = NO_FRIENDS;

function friendNames(): ReadonlySet<string> {
  const state = snapshot.state;
  if (state !== friendsFor) {
    friendsFor = state;
    friendSet = state ? new Set(state.friends.map((friend) => friend.name.toLowerCase())) : NO_FRIENDS;
  }
  return friendSet;
}

/** Lower-cased logins on the friends list, while the PC is connected. */
export function useFriendNames(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, friendNames);
}
