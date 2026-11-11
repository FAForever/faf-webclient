'use strict';

/**
 * Logging in a visitor, for the Chat tab.
 *
 * The browser does the OAuth part itself: it sends the visitor to FAF's login
 * page (Hydra, authorization code flow with PKCE, a public client without a
 * secret), and gets a one-time code back. Hydra and FAF's user service send no
 * CORS headers, so the browser cannot make the follow-up calls; this module
 * makes them for it and hands back only what the chat needs:
 *
 *   code      -> hydra /oauth2/token           -> access + refresh token
 *   access    -> user.faforever.com irc token  -> chat token (24 h)
 *   access    -> who it belongs to             -> user name and id
 *
 * The access token never leaves this server and nothing is stored here: the
 * refresh token goes back to the visitor's browser, which sends it again when
 * the chat token runs out. The browser then connects to FAF's chat server
 * directly, from the visitor's own address, as the desktop client does.
 *
 * Nothing in here is ever logged: codes and tokens included.
 */

const https = require('https');
const { postForm } = require('./faftoken');

// The public "FAF Web" client (gitops-stack apps/ory-hydra/values.yaml).
const DEFAULT_LOGIN_CLIENT_ID = '5dfd4eb7-0e09-4bf2-a815-cc0e90b435e6';
const OAUTH_BASE = 'https://hydra.faforever.com';
const API_BASE = 'https://api.faforever.com';
const IRC_TOKEN_URL = 'https://user.faforever.com/irc/ergochat/token';
const CHAT_URL = 'wss://chat.faforever.com';
// openid and offline for the refresh token; public_profile is what every FAF
// client asks for. No "lobby": that would demand proof of game ownership and
// is not needed to chat.
const SCOPE = 'openid offline public_profile';
const CALLBACK_PATH = '/auth/callback';
const TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 256 * 1024;

class LoginError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function getWithToken(url, token, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': 'faf-web'
      }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_REPLY_BYTES) { res.destroy(); reject(new Error('reply too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

function parse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** The claims of a JWT, unverified: it came straight from Hydra over TLS. */
function jwtClaims(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

const isString = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * The redirect URI has to be this site's own callback. Hydra checks it against
 * the client's registered list as well; this just keeps the relay from being
 * pointed anywhere else.
 */
function validRedirect(value) {
  if (!isString(value, 300)) return false;
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return (url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
    url.pathname === CALLBACK_PATH && !url.search && !url.hash && !url.username;
}

function createUserLogin({
  clientId = DEFAULT_LOGIN_CLIENT_ID,
  oauthBase = OAUTH_BASE,
  apiBase = API_BASE,
  ircTokenUrl = IRC_TOKEN_URL,
  chatUrl = CHAT_URL,
  postImpl = postForm,
  getImpl = getWithToken
} = {}) {
  if (!clientId) return null;
  const tokenUrl = oauthBase + '/oauth2/token';

  async function tokens(form, rejectedCode) {
    let res;
    try {
      res = await postImpl(tokenUrl, Object.assign({ client_id: clientId }, form));
    } catch (err) {
      throw new LoginError(502, 'login-unreachable', 'FAF login could not be reached');
    }
    const body = parse(res.body);
    if (res.status === 400 || res.status === 401) {
      // invalid_grant: the code was used or expired, or the refresh token is
      // no longer valid. Either way the visitor has to log in again.
      throw new LoginError(401, rejectedCode, 'FAF login refused: ' + ((body && body.error) || res.status));
    }
    if (res.status !== 200 || !body || typeof body.access_token !== 'string') {
      throw new LoginError(502, 'login-failed', 'FAF login answered ' + res.status);
    }
    return body;
  }

  async function whoIs(accessToken) {
    // FAF's access tokens are JWTs carrying the user name (faf-user-service
    // HydraService puts it in "ext"); the IRC token is made for that name too.
    const claims = jwtClaims(accessToken);
    const ext = claims && claims.ext;
    if (ext && typeof ext.username === 'string' && claims.sub) {
      return { id: String(claims.sub), name: ext.username };
    }
    // Not a JWT after all: ask the API, as the desktop client does.
    const res = await getImpl(apiBase + '/me', accessToken).catch(() => null);
    const me = res && res.status === 200 ? parse(res.body) : null;
    const data = me && me.data;
    const attributes = (data && data.attributes) || {};
    const name = attributes.userName || attributes.login;
    if (typeof name !== 'string') throw new LoginError(502, 'login-failed', 'could not tell who logged in');
    return { id: String(attributes.userId || data.id || ''), name };
  }

  async function chatToken(accessToken) {
    const res = await getImpl(ircTokenUrl, accessToken).catch(() => null);
    const body = res && res.status === 200 ? parse(res.body) : null;
    if (!body || typeof body.value !== 'string') {
      throw new LoginError(502, 'chat-token-failed', 'FAF did not hand out a chat token' + (res ? ' (' + res.status + ')' : ''));
    }
    return body.value;
  }

  async function session(grant) {
    const [user, token] = await Promise.all([whoIs(grant.access_token), chatToken(grant.access_token)]);
    return {
      user,
      chatToken: token,
      // Hydra hands out a new refresh token every time and retires the old one.
      refreshToken: typeof grant.refresh_token === 'string' ? grant.refresh_token : null
    };
  }

  return {
    clientId,

    /** What the browser needs to start a login and reach the chat. */
    config() {
      return {
        login: { clientId, authorizeUrl: oauthBase + '/oauth2/auth', scope: SCOPE, callbackPath: CALLBACK_PATH },
        chat: { url: chatUrl, channel: '#aeolus' }
      };
    },

    async login(input) {
      const { code, codeVerifier, redirectUri } = input || {};
      if (!isString(code, 2048) || !/^[A-Za-z0-9._~-]{43,128}$/.test(String(codeVerifier || '')) || !validRedirect(redirectUri)) {
        throw new LoginError(400, 'bad-request', 'code, codeVerifier and redirectUri are required');
      }
      const grant = await tokens({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
      }, 'login-rejected');
      return session(grant);
    },

    async refresh(input) {
      const { refreshToken } = input || {};
      if (!isString(refreshToken, 4096)) throw new LoginError(400, 'bad-request', 'refreshToken is required');
      const grant = await tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'session-expired');
      return session(grant);
    },

    /** Best effort: the browser forgets the session whatever this answers. */
    async logout(input) {
      const { refreshToken } = input || {};
      if (!isString(refreshToken, 4096)) return;
      await postImpl(oauthBase + '/oauth2/revoke', { token: refreshToken, client_id: clientId }).catch(() => null);
    }
  };
}

module.exports = { createUserLogin, LoginError, DEFAULT_LOGIN_CLIENT_ID, CHAT_URL, jwtClaims, validRedirect };
