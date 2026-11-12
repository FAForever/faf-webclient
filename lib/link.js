'use strict';

/**
 * The PC link: the FAF Rust client on a player's PC, and this site open in
 * the same player's browser (a phone in the kitchen, say), connected through
 * this server so the browser can start a matchmaker search or join a lobby
 * on the PC, and hear when a match is found.
 *
 *   Rust client --wss--> /api/link <--wss-- browser
 *
 * Both ends connect out to this server, so nothing on the PC listens on the
 * network and it works from anywhere. This server only ever passes messages
 * between the PC and the browsers of ONE FAF account:
 *
 *   - the PC proves who it is with its FAF access token, which must be signed
 *     by FAF's login server and issued to the Rust client (lib/jwt.js);
 *   - a browser proves it with a ticket this server signed when that browser
 *     logged in here (issueTicket, handed out with the chat login).
 *
 * The browser can ask for exactly four things (`commandFrom`), checked here
 * and again by the Rust client, which also has the switch that allows it at
 * all (off by default). Nothing is stored: the latest state the PC sent is
 * kept in memory for browsers that connect later, and lost on restart.
 *
 * One server process: the deployment runs one replica, and the link needs
 * the PC and the browser on the same one.
 *
 * Protocol (JSON text messages), version 1:
 *
 *   first message, either end:
 *     {type:"hello", role:"pc", version:1, token, client, device}
 *     {type:"hello", role:"web", version:1, ticket}
 *   server -> pc:   welcome {browsers}, browsers {count}, command {id, command}, replaced
 *   pc -> server:   state {state}, games {games}, event {event, queue?}, result {id, ok, error?}
 *   web -> server:  command {id, command}
 *   server -> web:  welcome {pc}, pc {pc}, state, games, event, result, error {code, message}
 */

const crypto = require('crypto');
const { upgrade } = require('./websocket');
const { allowedEndpoint } = require('./webpush');

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const PC_MAX_MESSAGE = 512 * 1024;
const WEB_MAX_MESSAGE = 8 * 1024;
const MAX_BROWSERS_PER_ACCOUNT = 8;
const MAX_PUSH_PER_ACCOUNT = 5;
/** Commands one browser may send per minute. */
const COMMANDS_PER_MINUTE = 30;
const TICKET_TTL_MS = 25 * 60 * 60 * 1000;

/** The FAF Rust client's OAuth client (gitops-stack apps/ory-hydra/values.yaml). */
const RUST_CLIENT_ID = '03c2132b-b5f8-4cbd-9901-499e83700f45';
/**
 * The Python client's OAuth client. The Rust client signed in with it until it
 * had its own, and a login it remembered from then is still renewed under it
 * (FAForeverRustClient infra/oauth.rs, LEGACY_CLIENT_ID), so those players'
 * tokens carry this id until they next sign in by hand.
 */
const LEGACY_RUST_CLIENT_ID = '95ecec08-29c1-4c48-ae0a-b000ff349cb8';

const QUEUE_NAME = /^[A-Za-z0-9_]{1,64}$/;
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const short = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * What a browser may ask the PC to do, normalised, or null for anything else.
 * The Rust client checks the same rules again before acting.
 */
function commandFrom(value) {
  if (!value || typeof value !== 'object') return null;
  switch (value.action) {
    case 'startSearch': {
      const queues = Array.isArray(value.queues) ? value.queues : [];
      if (queues.length < 1 || queues.length > 8 || !queues.every((q) => typeof q === 'string' && QUEUE_NAME.test(q))) return null;
      return { action: 'startSearch', queues: [...new Set(queues)] };
    }
    case 'stopSearch': {
      if (value.queues === undefined) return { action: 'stopSearch' };
      const queues = Array.isArray(value.queues) ? value.queues : null;
      if (!queues || queues.length > 8 || !queues.every((q) => typeof q === 'string' && QUEUE_NAME.test(q))) return null;
      return { action: 'stopSearch', queues };
    }
    case 'joinGame': {
      const id = value.gameId;
      if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) return null;
      if (value.password !== undefined && value.password !== null && !(typeof value.password === 'string' && value.password.length <= 100)) return null;
      return value.password ? { action: 'joinGame', gameId: id, password: value.password } : { action: 'joinGame', gameId: id };
    }
    case 'refresh':
      return { action: 'refresh' };
    default:
      return null;
  }
}

function parse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/** What a match-found notification says, from a queue's technical name. */
function queueLabel(name) {
  const known = {
    ladder1v1: '1v1', ladder_1v1: '1v1', tmm2v2: '2v2', tmm_2v2: '2v2', tmm3v3: '3v3',
    tmm4v4_full_share: '4v4', tmm_4v4_full_share: '4v4', tmm4v4_share_until_death: '4v4 no share',
    tmm_4v4_share_until_death: '4v4 no share'
  };
  return known[name] || String(name || '').replace(/_/g, ' ');
}

/**
 * @param {object} options
 * @param {{verify: (token: string) => Promise<object>}} options.tokens  lib/jwt.js
 * @param {string[]} [options.clientIds]  OAuth clients whose tokens may act as the PC
 * @param {string} [options.secret]  signs browser tickets; random per process when absent
 * @param {object} [options.push]  lib/webpush.js, or null for no phone notifications
 * @param {(origin: string|undefined, req: object) => boolean} [options.allowedOrigin]  browser origins
 * @param {Function} [options.log]
 */
function createLink({ tokens, clientIds = [RUST_CLIENT_ID, LEGACY_RUST_CLIENT_ID], secret, push = null, allowedOrigin = () => true, log = () => {}, now = Date.now }) {
  const ticketKey = secret ? Buffer.from(secret) : crypto.randomBytes(32);
  /** account id -> { pc, pcInfo, browsers:Set, state, games, push:Map } */
  const accounts = new Map();

  function account(id) {
    let entry = accounts.get(id);
    if (!entry) {
      entry = { pc: null, pcInfo: null, browsers: new Set(), state: null, games: null, push: new Map() };
      accounts.set(id, entry);
    }
    return entry;
  }

  function forget(id) {
    const entry = accounts.get(id);
    if (entry && !entry.pc && entry.browsers.size === 0 && entry.push.size === 0) accounts.delete(id);
  }

  // ---- browser tickets

  function sign(data) {
    return crypto.createHmac('sha256', ticketKey).update(data).digest('base64url');
  }

  /** A ticket for a browser that just logged in as `user` ({id, name}). */
  function issueTicket(user) {
    const data = Buffer.from(JSON.stringify({ u: String(user.id), n: String(user.name), e: now() + TICKET_TTL_MS })).toString('base64url');
    return data + '.' + sign(data);
  }

  function verifyTicket(ticket) {
    if (typeof ticket !== 'string' || ticket.length > 1024) return null;
    const [data, mac] = ticket.split('.');
    if (!data || !mac) return null;
    const expected = Buffer.from(sign(data));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    const body = parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!body || typeof body.u !== 'string' || !/^\d{1,12}$/.test(body.u) || typeof body.e !== 'number' || body.e < now()) return null;
    return { id: body.u, name: String(body.n || '') };
  }

  // ---- connections

  function pcSummary(entry) {
    return entry.pc ? Object.assign({ connected: true }, entry.pcInfo) : { connected: false };
  }

  function toBrowsers(entry, message) {
    for (const browser of entry.browsers) browser.sendJson(message);
  }

  function browsersChanged(entry) {
    if (entry.pc) entry.pc.sendJson({ type: 'browsers', count: entry.browsers.size });
  }

  async function notifyPhones(id, entry, event) {
    if (!push || !entry.push.size) return;
    const label = queueLabel(event.queue);
    const message = {
      title: 'Match found',
      body: `Your ${label} game is starting on your PC.`,
      tag: 'faf-match-found',
      url: '/play'
    };
    for (const [endpoint, subscription] of entry.push) {
      push.send(subscription, message, { ttlSeconds: 90, urgency: 'high', topic: 'match' })
        .then((res) => {
          if (res.status === 404 || res.status === 410) {
            entry.push.delete(endpoint);
            forget(id);
          } else if (res.status >= 400) {
            log('warn', 'link push refused', { status: res.status });
          }
        })
        .catch((err) => log('warn', 'link push failed', { reason: err.message }));
    }
  }

  function attachPc(conn, id, name, hello) {
    const entry = account(id);
    const older = entry.pc;
    // Taken over before the old one closes, so its close handler sees it is
    // no longer the account's PC and leaves the account alone.
    entry.pc = conn;
    if (older) {
      // One PC per account: the newest wins, and the old one is told why.
      older.sendJson({ type: 'replaced' });
      older.close(4001, 'another PC connected');
    }
    entry.pcInfo = { client: short(hello.client, 80), device: short(hello.device, 80), name };
    entry.state = null;
    entry.games = null;
    conn.sendJson({ type: 'welcome', version: PROTOCOL_VERSION, browsers: entry.browsers.size });
    toBrowsers(entry, { type: 'pc', pc: pcSummary(entry) });
    log('info', 'link pc connected', { browsers: entry.browsers.size });

    conn.on('message', (text) => {
      const msg = parse(text);
      if (!msg) return;
      switch (msg.type) {
        case 'state':
          if (!msg.state || typeof msg.state !== 'object') return;
          entry.state = msg.state;
          toBrowsers(entry, { type: 'state', state: msg.state });
          return;
        case 'games':
          if (!Array.isArray(msg.games)) return;
          entry.games = msg.games;
          toBrowsers(entry, { type: 'games', games: msg.games });
          return;
        case 'event': {
          const event = { type: 'event', event: short(msg.event, 40), queue: short(msg.queue, 64) || undefined };
          toBrowsers(entry, event);
          if (event.event === 'matchFound') notifyPhones(id, entry, event);
          return;
        }
        case 'result':
          if (!isText(msg.id, 64)) return;
          toBrowsers(entry, { type: 'result', id: msg.id, ok: msg.ok === true, error: short(msg.error, 300) || undefined });
          return;
        default:
      }
    });
    conn.on('close', () => {
      if (entry.pc !== conn) return;
      entry.pc = null;
      entry.pcInfo = null;
      entry.state = null;
      entry.games = null;
      toBrowsers(entry, { type: 'pc', pc: pcSummary(entry) });
      log('info', 'link pc disconnected');
      forget(id);
    });
  }

  function attachBrowser(conn, id) {
    const entry = account(id);
    if (entry.browsers.size >= MAX_BROWSERS_PER_ACCOUNT) {
      conn.sendJson({ type: 'error', code: 'too-many-browsers', message: 'Too many browsers are connected to this account.' });
      conn.close(4008, 'too many browsers');
      return;
    }
    entry.browsers.add(conn);
    conn.sendJson({ type: 'welcome', version: PROTOCOL_VERSION, pc: pcSummary(entry) });
    if (entry.state) conn.sendJson({ type: 'state', state: entry.state });
    if (entry.games) conn.sendJson({ type: 'games', games: entry.games });
    browsersChanged(entry);

    let windowStart = now();
    let sent = 0;
    conn.on('message', (text) => {
      const msg = parse(text);
      if (!msg || msg.type !== 'command') return;
      const commandId = isText(msg.id, 64) ? msg.id : null;
      if (!commandId) return;
      if (now() - windowStart > 60_000) { windowStart = now(); sent = 0; }
      if (++sent > COMMANDS_PER_MINUTE) {
        conn.sendJson({ type: 'result', id: commandId, ok: false, error: 'Too many requests, wait a minute.' });
        return;
      }
      const command = commandFrom(msg.command);
      if (!command) {
        conn.sendJson({ type: 'result', id: commandId, ok: false, error: 'Not something the web client may ask for.' });
        return;
      }
      if (!entry.pc) {
        conn.sendJson({ type: 'result', id: commandId, ok: false, error: 'Your PC is not connected.' });
        return;
      }
      entry.pc.sendJson({ type: 'command', id: commandId, command });
    });
    conn.on('close', () => {
      entry.browsers.delete(conn);
      browsersChanged(entry);
      forget(id);
    });
  }

  /** server.on('upgrade') for /api/link. */
  function handleUpgrade(req, socket, head) {
    const conn = upgrade(req, socket, head, { maxMessageBytes: PC_MAX_MESSAGE });
    if (!conn) return;
    const origin = req.headers.origin;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) conn.close(4000, 'no hello');
    }, HELLO_TIMEOUT_MS);
    timer.unref();

    const fail = (code, message) => {
      settled = true;
      clearTimeout(timer);
      conn.sendJson({ type: 'error', code, message });
      conn.close(4003, code);
    };

    conn.once('message', async (text) => {
      const hello = parse(text);
      if (!hello || hello.type !== 'hello') return fail('bad-hello', 'The first message must be a hello.');
      if (hello.version !== PROTOCOL_VERSION) return fail('version', `This server speaks link version ${PROTOCOL_VERSION}.`);

      if (hello.role === 'web') {
        // A browser on another site must not ride on a visitor's ticket.
        if (!allowedOrigin(origin, req)) return fail('origin', 'Not allowed from this site.');
        const user = verifyTicket(hello.ticket);
        if (!user) return fail('ticket', 'Log in again.');
        settled = true;
        clearTimeout(timer);
        conn.maxMessageBytes = WEB_MAX_MESSAGE;
        conn.startHeartbeat(HEARTBEAT_MS);
        attachBrowser(conn, user.id);
        return;
      }

      if (hello.role === 'pc') {
        // A desktop client sends no Origin; a web page always does.
        if (origin) return fail('origin', 'The PC side is for the desktop client.');
        let claims;
        try {
          claims = await tokens.verify(hello.token);
        } catch (err) {
          log('warn', 'link pc refused', { code: err.code || 'token' });
          return fail('token', 'FAF did not vouch for this login: ' + err.message);
        }
        if (!clientIds.includes(claims.client_id)) return fail('client', 'Only the FAF Rust client can connect here.');
        const id = claims.sub != null ? String(claims.sub) : '';
        if (!/^\d{1,12}$/.test(id)) return fail('token', 'The login has no FAF account in it.');
        if (conn.closed) return;
        settled = true;
        clearTimeout(timer);
        conn.startHeartbeat(HEARTBEAT_MS);
        const name = claims.ext && typeof claims.ext.username === 'string' ? claims.ext.username : '';
        attachPc(conn, id, name, hello);
        return;
      }

      fail('bad-hello', 'Unknown role.');
    });
  }

  /** POST /api/link/push: keep or drop a browser's push subscription. */
  function setPush({ ticket, subscription, endpoint, remove } = {}) {
    const user = verifyTicket(ticket);
    if (!user) return { status: 401, body: { error: 'Log in again.', code: 'ticket' } };
    if (!push) return { status: 503, body: { error: 'Phone notifications are off on this server.', code: 'push-off' } };
    const entry = account(user.id);
    if (remove) {
      if (typeof endpoint === 'string') entry.push.delete(endpoint);
      forget(user.id);
      return { status: 200, body: { ok: true } };
    }
    const keys = subscription && subscription.keys;
    const valid = subscription && isText(subscription.endpoint, 1024) && keys && isText(keys.p256dh, 200) && isText(keys.auth, 100);
    if (!valid) return { status: 400, body: { error: 'Not a push subscription.', code: 'bad-subscription' } };
    if (!allowedEndpoint(subscription.endpoint)) return { status: 400, body: { error: 'Not a browser push service.', code: 'bad-subscription' } };
    entry.push.delete(subscription.endpoint);
    entry.push.set(subscription.endpoint, { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    while (entry.push.size > MAX_PUSH_PER_ACCOUNT) entry.push.delete(entry.push.keys().next().value);
    return { status: 200, body: { ok: true } };
  }

  function stats() {
    let pcs = 0;
    let browsers = 0;
    for (const entry of accounts.values()) {
      if (entry.pc) pcs++;
      browsers += entry.browsers.size;
    }
    return { pcs, browsers, push: Boolean(push) };
  }

  return { handleUpgrade, issueTicket, verifyTicket, setPush, stats, pushKey: push ? push.publicKey : null };
}

module.exports = { createLink, commandFrom, RUST_CLIENT_ID, LEGACY_RUST_CLIENT_ID, PROTOCOL_VERSION };
