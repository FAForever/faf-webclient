'use strict';

/**
 * FAF webclient - a FAF website in the Rust client's design, hosted by FAF at
 * webclient.faforever.com (gitops-stack apps/faf-webclient).
 *
 * One process does two jobs:
 *   1. serves the app out of public/
 *   2. proxies the read-only upstream APIs under /api/
 *
 * Job 2 exists so the browser only ever talks to this origin. That removes the
 * CORS question entirely: it does not matter whether api.faforever.com allows
 * browser origins, because no browser ever calls it directly. It also means
 * the tournament site does not need CORS headers added.
 *
 * No database. The one optional secret is the service login for FAF's API
 * (FAF_API_CLIENT_ID / FAF_API_CLIENT_SECRET, lib/faftoken.js), which Maps,
 * Mods and Replays need because FAF's API serves no anonymous listings.
 * Without it those tabs say so; everything else still works.
 *
 * Visitors can log in for the Chat tab (lib/userlogin.js). The server only
 * relays the login calls the browser cannot make itself and keeps nothing:
 * the chat connection goes from the browser straight to FAF's chat server.
 *
 * The PC link (lib/link.js) connects a player's FAF Rust client and their
 * browser, so the browser can start a matchmaker search on the PC and be told
 * when a match is found. Messages only pass between one account's own PC and
 * browsers; nothing is stored. FAF_LINK=off switches it off.
 *
 * FAF_BASE_DOMAIN (lib/hosts.js) picks FAF's real servers or its test ones.
 *
 * Zero runtime dependencies, no build step. Upload the files, restart the
 * container.
 */

const http = require('http');
const path = require('path');

const { resolve: resolveUpstream } = require('./lib/upstreams');
const { createCache, proxyGet, servedContentType } = require('./lib/proxy');
const { resolveFile, cacheHeader } = require('./lib/static');
const { createWatcher } = require('./lib/watcher');
const { createTokenSource } = require('./lib/faftoken');
const { createUserLogin, CHAT_URL } = require('./lib/userlogin');
const { boardTarget, pageOf, apiTarget, pageFromApi } = require('./lib/leaderboard');
const { BASE_DOMAIN, IN_CLUSTER, fafUrl, serverUrl } = require('./lib/hosts');
const { createLink } = require('./lib/link');
const { createJwtVerifier } = require('./lib/jwt');
const { createWebPush } = require('./lib/webpush');

const PORT = Number(process.env.PORT || 8098);
// Auto-update. Off unless AUTO_UPDATE=1, so nothing changes for anyone who
// does not ask for it. See lib/watcher.js for why this is a poll and not a
// webhook, and why a bad commit cannot take the site down.
const AUTO_UPDATE = process.env.AUTO_UPDATE === '1';
const UPDATE_BRANCH = process.env.UPDATE_BRANCH || 'main';
const UPDATE_INTERVAL_MS = Math.max(30_000, Number(process.env.UPDATE_INTERVAL_MS || 60_000));
const APP_DIR = process.env.APP_DIR || __dirname;
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const started = Date.now();
const cache = createCache();
const serviceLogin = createTokenSource({
  clientId: process.env.FAF_API_CLIENT_ID,
  clientSecret: process.env.FAF_API_CLIENT_SECRET,
  tokenUrl: process.env.FAF_OAUTH_TOKEN_URL || undefined
});
// The Chat tab's login. On by default with FAF's "FAF Web" client;
// FAF_LOGIN_CLIENT_ID=off switches it off, any other value replaces the id.
const loginClientId = process.env.FAF_LOGIN_CLIENT_ID;
const userLogin = loginClientId === 'off' ? null : createUserLogin(loginClientId ? { clientId: loginClientId } : {});
const MAX_BODY_BYTES = 8 * 1024;
let watcher = null;

// The PC link. Needs the chat login (browsers get their link ticket with it).
// Phone notifications use a key made at start unless FAF_LINK_VAPID_KEY keeps one.
const LINK_PATH = '/api/link';
const link = process.env.FAF_LINK === 'off' || !userLogin ? null : createLink({
  tokens: createJwtVerifier({
    jwksUrl: serverUrl('hydra') + '/.well-known/jwks.json',
    issuers: [fafUrl('hydra')]
  }),
  clientIds: process.env.FAF_LINK_CLIENT_IDS ? process.env.FAF_LINK_CLIENT_IDS.split(',').map((id) => id.trim()).filter(Boolean) : undefined,
  secret: process.env.FAF_LINK_SECRET || undefined,
  push: process.env.FAF_LINK_PUSH === 'off' ? null : createWebPush({
    subject: fafUrl('webclient'),
    privateKeyPem: process.env.FAF_LINK_VAPID_KEY || undefined
  }),
  // Same origin only: the page that asks must be this site.
  allowedOrigin: (origin, req) => {
    try { return Boolean(origin) && new URL(origin).host === req.headers.host; } catch (_) { return false; }
  },
  log: (level, msg, extra) => log(level, msg, extra)
});

/* ------------------------------------------------------------------ logging */

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg };
  if (extra) Object.assign(line, extra);
  process.stdout.write(JSON.stringify(line) + '\n');
}

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // The app embeds upstream pages (news, changelog, unit db, FAF Daily) in
    // iframes, so frame-src has to name them. Everything else is same-origin.
    // The unit db moved from faforever.github.io/etfreeman-db to its own
    // domain in November 2026; the old address redirects there.
    'Content-Security-Policy': [
      "default-src 'self'",
      // FAF's content server (maps, mods, avatars), the news hub's pictures
      // (WordPress) and the patch notes' unit icons.
      "img-src 'self' " + fafUrl('content') + " https://direct.faforever.com https://faforever.github.io data:",
      // News and FAF Daily are FAF's own sites, so they follow the base
      // domain; the changelog and unit db exist only once.
      "frame-src " + fafUrl('www') + " " + fafUrl('daily') + " https://faforever.github.io https://unitdb.faforever.com https://www.youtube-nocookie.com",
      // The Chat tab talks to FAF's chat server directly over a WebSocket;
      // the PC link is a WebSocket to this site ('self' covers it in current
      // browsers, the explicit address covers the rest).
      "connect-src 'self' " + CHAT_URL + ' ' + fafUrl('webclient', 'wss'),
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')
  };
}

/* ------------------------------------------------------------------- routing */

async function handleApi(req, res, url) {
  if (url.pathname.startsWith('/api/auth/')) {
    await handleAuth(req, res, url.pathname.slice('/api/auth/'.length));
    return;
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    // The site needs the base domain for its own links (map previews,
    // replay downloads, news).
    sendJson(res, 200, Object.assign(
      { baseDomain: BASE_DOMAIN },
      userLogin ? userLogin.config() : { login: null, chat: null },
      { link: link ? { path: LINK_PATH, pushKey: link.pushKey } : null }
    ));
    return;
  }
  if (url.pathname === LINK_PATH + '/push') {
    await handleLinkPush(req, res);
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'this API is read-only' });
    return;
  }

  // /api/<route>/<rest...>
  const parts = url.pathname.split('/').filter(Boolean); // ['api', route, ...rest]
  const routeName = parts[1];
  const rest = parts.slice(2).join('/');

  if (routeName === 'leaderboard') {
    await handleLeaderboard(res, rest, url);
    return;
  }

  const target = resolveUpstream(routeName, rest, url.search);
  if (!target) {
    // Deliberately identical answer for "unknown route" and "blocked resource",
    // so this cannot be used to enumerate what is reachable.
    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }

  const opts = {};
  if (target.needsServiceLogin) {
    const headers = await serviceLoginHeaders(res);
    if (!headers) return;
    opts.headers = headers;
  }

  const t0 = Date.now();
  const out = await proxyGet(target, cache, opts);
  // A token revoked or expired early: fetch a fresh one on the next request.
  if (target.needsServiceLogin && out.status === 401) serviceLogin.invalidate();
  log(out.status >= 400 ? 'warn' : 'info', 'proxy', Object.assign({
    route: routeName, rest, status: out.status,
    ms: Date.now() - t0, cached: out.cached, bytes: out.body.length
  }, out.via || {}));

  res.writeHead(out.status, Object.assign({
    'Content-Type': servedContentType(out.contentType),
    'Content-Length': out.body.length,
    'Cache-Control': 'no-store',
    'X-Cache': out.cached ? 'HIT' : 'MISS'
  }, securityHeaders()));
  res.end(out.body);
}

/**
 * The Authorization header for FAF's API, or null after answering the request
 * with the reason there is none.
 */
async function serviceLoginHeaders(res) {
  if (!serviceLogin) {
    sendJson(res, 503, {
      error: 'FAF API service login is not configured',
      code: 'service-login-missing'
    });
    return null;
  }
  try {
    return { Authorization: 'Bearer ' + await serviceLogin.get() };
  } catch (err) {
    log('error', 'service login failed', { reason: err.message });
    sendJson(res, 502, { error: 'FAF API service login failed', code: 'service-login-failed' });
    return null;
  }
}

/**
 * /api/leaderboard/<board>?page=N&q=name - one page of a leaderboard.
 *
 * With the service login: straight from FAF's API, one page per request.
 * Without it: faforever.com's public JSON, paged here. That host is behind
 * Cloudflare, which can refuse a server (403); that case gets its own code so
 * the page can say what is going on.
 */
async function handleLeaderboard(res, board, url) {
  const options = {
    page: url.searchParams.get('page'),
    query: url.searchParams.get('q') || ''
  };
  const viaApi = Boolean(serviceLogin);
  const target = viaApi ? apiTarget(board, options) : boardTarget(board);
  if (!target) {
    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }
  const opts = {};
  if (viaApi) {
    const headers = await serviceLoginHeaders(res);
    if (!headers) return;
    opts.headers = headers;
  }
  const t0 = Date.now();
  const out = await proxyGet(target, cache, opts);
  if (viaApi && out.status === 401) serviceLogin.invalidate();
  log(out.status >= 400 ? 'warn' : 'info', 'proxy', Object.assign({
    route: 'leaderboard', rest: board, source: viaApi ? 'api' : 'website', status: out.status,
    ms: Date.now() - t0, cached: out.cached, bytes: out.body.length
  }, out.via || {}));
  if (!viaApi && out.status === 403) {
    sendJson(res, 502, {
      error: 'www.' + BASE_DOMAIN + ' refused this server\'s request',
      code: 'leaderboard-refused'
    });
    return;
  }
  if (out.status !== 200) {
    res.writeHead(out.status, Object.assign({
      'Content-Type': out.contentType,
      'Content-Length': out.body.length,
      'Cache-Control': 'no-store'
    }, securityHeaders()));
    res.end(out.body);
    return;
  }
  let page;
  try {
    page = viaApi ? pageFromApi(out.body, options) : pageOf(out.body, options);
  } catch (err) {
    log('error', 'leaderboard unreadable', { board, reason: err.message });
    sendJson(res, 502, { error: 'leaderboard data was unreadable' });
    return;
  }
  sendJson(res, 200, page, { 'X-Cache': out.cached ? 'HIT' : 'MISS' });
}

/** A small JSON request body, or null after answering why there is none. */
function readJsonBody(req, res) {
  return new Promise((resolve) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { error: 'send JSON' });
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        sendJson(res, 413, { error: 'request too large' });
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        sendJson(res, 400, { error: 'bad JSON' });
        resolve(null);
      }
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

/**
 * POST /api/auth/login | refresh | logout - see lib/userlogin.js. Answers carry
 * tokens, so nothing here is cached or logged beyond the outcome.
 */
async function handleAuth(req, res, action) {
  if (!['login', 'refresh', 'logout'].includes(action)) {
    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'use POST' });
    return;
  }
  if (!userLogin) {
    sendJson(res, 503, { error: 'login is switched off on this server', code: 'login-off' });
    return;
  }
  const body = await readJsonBody(req, res);
  if (!body) return;
  const t0 = Date.now();
  try {
    if (action === 'logout') {
      await userLogin.logout(body);
      sendJson(res, 200, { ok: true });
      log('info', 'auth', { action, ms: Date.now() - t0 });
      return;
    }
    const session = await userLogin[action](body);
    // The browser's pass to the PC link, renewed with every chat token.
    if (link && session.user && /^\d+$/.test(session.user.id)) session.linkTicket = link.issueTicket(session.user);
    sendJson(res, 200, session);
    log('info', 'auth', { action, ok: true, ms: Date.now() - t0 });
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || 'internal';
    log(status >= 500 ? 'error' : 'warn', 'auth', { action, ok: false, status, code, ms: Date.now() - t0 });
    sendJson(res, status, { error: status >= 500 && !err.code ? 'internal error' : err.message, code });
  }
}

/** POST /api/link/push: the browser's push subscription for match-found notifications. */
async function handleLinkPush(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: 'use POST' });
    return;
  }
  if (!link) {
    sendJson(res, 503, { error: 'the PC link is switched off on this server', code: 'link-off' });
    return;
  }
  const body = await readJsonBody(req, res);
  if (!body) return;
  const result = link.setPush(body);
  sendJson(res, result.status, result.body);
}

function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  let found = resolveFile(PUBLIC_DIR, url.pathname);

  // SPA fallback: unknown paths that are not file requests render the app, so
  // /maps and /leaderboard work on a refresh and as shared links.
  if (!found && !path.extname(url.pathname)) {
    found = resolveFile(PUBLIC_DIR, '/index.html');
  }

  if (!found) {
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, securityHeaders()));
    res.end('Not found');
    return;
  }

  const fs = require('fs');
  const stat = fs.statSync(found.file);
  res.writeHead(200, Object.assign({
    'Content-Type': found.type,
    'Content-Length': stat.size,
    'Cache-Control': cacheHeader(found.file)
  }, securityHeaders()));

  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(found.file).pipe(res);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch (_) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: 'faf-webclient',
      baseDomain: BASE_DOMAIN,
      // true in FAF's cluster: FAF's services are called by their internal names.
      inCluster: IN_CLUSTER,
      uptimeSeconds: Math.floor((Date.now() - started) / 1000),
      cacheEntries: cache.size(),
      playTab: true,
      serviceLogin: Boolean(serviceLogin),
      chatLogin: Boolean(userLogin),
      link: link ? link.stats() : { enabled: false },
      autoUpdate: watcher ? watcher.status() : { enabled: false }
    });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      log('error', 'unhandled', { reason: err && err.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return;
  }

  handleStatic(req, res, url);
});

// The PC link's WebSockets. Anything else asking to upgrade is refused.
server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch (_) { /* refused below */ }
  if (link && pathname === LINK_PATH) {
    link.handleUpgrade(req, socket, head);
    return;
  }
  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
});

server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 65_000;

function shutdown(sig) {
  log('info', 'shutting down', { signal: sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  server.listen(PORT, () => {
    log('info', 'listening', {
      port: PORT, publicDir: PUBLIC_DIR, autoUpdate: AUTO_UPDATE, baseDomain: BASE_DOMAIN,
      // Where the server itself reaches FAF: internal names in FAF's cluster.
      api: serverUrl('api'), hydra: serverUrl('hydra'), userService: serverUrl('user')
    });
  });

  if (AUTO_UPDATE) {
    watcher = createWatcher({
      appDir: APP_DIR,
      branch: UPDATE_BRANCH,
      intervalMs: UPDATE_INTERVAL_MS,
      log,
      onDeploy: () => {
        // Exiting IS the deploy: Docker's restart policy brings the container
        // back and the command re-clones. Close the listener first so in-flight
        // requests finish.
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5_000).unref();
      }
    });
    watcher.start();
  }
}

module.exports = { server, link };
