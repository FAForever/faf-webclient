'use strict';

/**
 * Self-contained suite. Unit-tests the two pieces that carry the risk (the
 * upstream allowlist and the static path resolver), then boots the real server
 * over real HTTP for the routing and header behaviour.
 *
 * No network is required. The proxy's upstream fetch is injectable, so every
 * branch is driven with a stub rather than by hoping api.faforever.com answers.
 *
 *   node webtest.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The suite checks the real FAF host names. The deployment's own setting
// (FAF_BASE_DOMAIN=faforever.xyz on FAF's test cluster) must not change that:
// the suite also runs inside a container before every auto-update.
// The same goes for running inside Kubernetes and the per-service overrides.
for (const name of ['FAF_BASE_DOMAIN', 'KUBERNETES_SERVICE_HOST', 'FAF_API_URL', 'FAF_HYDRA_URL',
  'FAF_USER_SERVICE_URL', 'FAF_WEBSITE_URL', 'FAF_TOURNAMENTS_URL', 'FAF_LOBBY_URL']) {
  delete process.env[name];
}

const { resolve } = require('./lib/upstreams');
const { createCache, proxyGet, servedContentType, UPSTREAM_HEADERS } = require('./lib/proxy');
const { resolveFile } = require('./lib/static');
const { createWatcher, redactUrl } = require('./lib/watcher');
const { createTokenSource } = require('./lib/faftoken');
const { boardTarget, pageOf, apiTarget, pageFromApi, PAGE_SIZE } = require('./lib/leaderboard');
const { createUserLogin, jwtClaims, validRedirect } = require('./lib/userlogin');
const { createLink, commandFrom, RUST_CLIENT_ID, LEGACY_RUST_CLIENT_ID } = require('./lib/link');
const { createJwtVerifier } = require('./lib/jwt');
const { createWebPush, encrypt, allowedEndpoint } = require('./lib/webpush');
const crypto = require('crypto');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name + (detail ? '  -> ' + detail : ''));
  return false;
}
function eq(a, b, name) {
  return ok(a === b, name, 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

/* ------------------------------------------------- the allowlist (security) */

function testUpstreams() {
  const good = resolve('faf', 'map', '?page%5Bsize%5D=5');
  ok(good !== null, 'upstream: an allowlisted resource resolves');
  ok(good && good.url === 'https://api.faforever.com/data/map?page%5Bsize%5D=5',
    'upstream: the URL is rebuilt on our side, query preserved', good && good.url);

  const lobby = resolve('lobby', 'games', '');
  ok(lobby && lobby.url === 'https://lobby.faforever.com/games',
    'upstream: the public lobby list resolves to lobby.faforever.com/games', lobby && lobby.url);
  const news = resolve('news', 'newshub.json', '');
  ok(news && news.url === 'https://www.faforever.com/data/newshub.json', 'upstream: the news hub resolves to the website\'s newshub.json', news && news.url);
  eq(resolve('news', 'clans.json', ''), null, 'upstream: nothing else in the website\'s /data');
  const index = resolve('changelog', 'changelog', '');
  ok(index && index.url === 'https://faforever.github.io/fa/changelog', 'upstream: the patch index resolves to the FA docs site', index && index.url);
  eq(resolve('changelog', 'assets/js/x.js', ''), null, 'upstream: nothing else on the FA docs site');
  const note = resolve('patchnote', '2026-08-14-3837.md', '');
  ok(note && note.url === 'https://raw.githubusercontent.com/FAForever/fa/master/docs/_posts/2026-08-14-3837.md',
    'upstream: a patch note resolves to its Markdown source', note && note.url);
  eq(resolve('patchnote', '../../README.md', ''), null, 'upstream: patch notes cannot leave the posts folder');
  eq(resolve('patchnote', 'secrets.md', ''), null, 'upstream: only dated patch notes');
  eq(servedContentType('text/html; charset=utf-8'), 'text/plain; charset=utf-8', 'proxy: another site\'s HTML is served as plain text');
  eq(servedContentType('application/vnd.api+json'), 'application/vnd.api+json', 'proxy: JSON keeps its type');
  const queues = resolve('lobby', 'matchmaker', '');
  ok(queues && queues.url === 'https://lobby.faforever.com/matchmaker',
    'upstream: the public matchmaker queues resolve to lobby.faforever.com/matchmaker', queues && queues.url);
  eq(resolve('lobby', 'players', ''), null, 'upstream: nothing else on the lobby host is reachable');

  eq(resolve('faf', 'secretThing', ''), null, 'upstream: a resource not on the allowlist is refused');
  eq(resolve('nope', 'map', ''), null, 'upstream: an unknown route is refused');
  eq(resolve('faf', '../../etc/passwd', ''), null, 'upstream: traversal is refused');
  eq(resolve('faf', 'map/../../x', ''), null, 'upstream: traversal mid-path is refused');
  eq(resolve('faf', '/data/map', ''), null, 'upstream: a leading slash is refused');
  eq(resolve('faf', 'evil.com/x', ''), null, 'upstream: a host-looking segment is refused');
  eq(resolve('faf', 'map%00', ''), null, 'upstream: percent escapes are refused');
  eq(resolve('faf', 'map\\x', ''), null, 'upstream: backslashes are refused');
  eq(resolve('faf', '', ''), null, 'upstream: an empty path is refused');

  // The open-relay check: nothing a caller sends may change the target host.
  const sneaky = resolve('faf', 'map', '?x=1#@evil.com');
  ok(!sneaky || sneaky.url.startsWith('https://api.faforever.com/'),
    'upstream: the caller cannot redirect the request to another host', sneaky && sneaky.url);

  const ev = resolve('events', 'calendar.json', '');
  ok(ev && ev.url === 'https://raw.githubusercontent.com/FAForeverRustClient/events/main/calendar.json',
    'upstream: the events calendar resolves', ev && ev.url);
  eq(resolve('events', 'other.json', ''), null, 'upstream: only the calendar file is reachable');

  const t = resolve('tourney', 'tournaments', '');
  ok(t && t.url === 'https://tournaments.faforever.com/api/tournaments',
    'upstream: the tourney API resolves to FAF\'s host', t && t.url);
  eq(t && t.needsServiceLogin, false, 'upstream: the tourney API needs no service login');

  const g = resolve('faf', 'game', '?sort=-endTime');
  ok(g && g.url.startsWith('https://api.faforever.com/data/game?'), 'upstream: replays (game) resolve', g && g.url);
  eq(g && g.needsServiceLogin, true, 'upstream: FAF API reads are marked as needing the service login');
}

/* --------------------------------------------------------- service login */
async function testServiceLogin() {
  let seen = null;
  const capture = async (url, opts) => {
    seen = opts && opts.headers;
    return { status: 200, contentType: 'application/json', body: Buffer.from('{}') };
  };
  await proxyGet({ url: 'https://api.faforever.com/data/game', ttlMs: 1 }, createCache(),
    { fetchImpl: capture, headers: { Authorization: 'Bearer t' } });
  eq(seen && seen.Authorization, 'Bearer t', 'login: the proxy forwards the Authorization header upstream');

  eq(createTokenSource({}), null, 'login: no client configured gives no token source');
  eq(createTokenSource({ clientId: 'a' }), null, 'login: a client without a secret gives no token source');

  let clock = 1_000_000;
  const calls = [];
  const post = async (url, form) => {
    calls.push({ url, form });
    return { status: 200, body: JSON.stringify({ access_token: 'tok' + calls.length, expires_in: 3600 }) };
  };
  const src = createTokenSource({ clientId: 'id', clientSecret: 'sec', postImpl: post, now: () => clock });

  const [a, b] = await Promise.all([src.get(), src.get()]);
  eq(calls.length, 1, 'login: concurrent requests share one token request');
  eq(a + b, 'tok1tok1', 'login: both callers get the token');
  eq(calls[0].url, 'https://hydra.faforever.com/oauth2/token', 'login: tokens come from FAF\'s Hydra');
  eq(calls[0].form.grant_type, 'client_credentials', 'login: uses the client_credentials grant');
  eq(calls[0].form.client_secret, 'sec', 'login: sends the secret in the body (client_secret_post)');

  clock += 30 * 60_000;
  eq(await src.get(), 'tok1', 'login: a valid token is reused');
  clock += 30 * 60_000;
  eq(await src.get(), 'tok2', 'login: an expiring token is renewed early');
  src.invalidate();
  eq(await src.get(), 'tok3', 'login: invalidate forces a new token');

  const bad = createTokenSource({
    clientId: 'id', clientSecret: 'wrong', now: () => clock,
    postImpl: async () => ({ status: 401, body: JSON.stringify({ error: 'invalid_client' }) })
  });
  let msg = '';
  try { await bad.get(); } catch (err) { msg = err.message; }
  ok(/401 invalid_client/.test(msg), 'login: a rejected client reports why', msg);
  ok(!msg.includes('wrong'), 'login: the error never contains the secret');
}

/* ------------------------------------------------------------ user login */

function fakeJwt(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return part({ alg: 'RS256' }) + '.' + part(claims) + '.sig';
}

async function testUserLogin() {
  const posts = [];
  const gets = [];
  let tokenReply = { status: 200, body: JSON.stringify({ access_token: fakeJwt({ sub: '4242', ext: { username: 'Nuggets' } }), refresh_token: 'r2', expires_in: 3600 }) };
  const login = createUserLogin({
    clientId: 'web-client',
    postImpl: async (url, form) => { posts.push({ url, form }); return tokenReply; },
    getImpl: async (url, token) => {
      gets.push({ url, token });
      if (url.endsWith('/irc/ergochat/token')) return { status: 200, body: JSON.stringify({ value: 'irc-token' }) };
      return { status: 404, body: '' };
    }
  });

  const cfg = login.config();
  eq(cfg.login.clientId, 'web-client', 'user login: config names the public client');
  eq(cfg.login.authorizeUrl, 'https://hydra.faforever.com/oauth2/auth', 'user login: logins go to FAF\'s Hydra');
  ok(!/\blobby\b/.test(cfg.login.scope), 'user login: does not ask for the lobby scope (no ownership check needed to chat)');
  ok(/\boffline\b/.test(cfg.login.scope), 'user login: asks for a refresh token');
  eq(cfg.chat.url, 'wss://chat.faforever.com', 'user login: config names FAF\'s chat server');

  const verifier = 'v'.repeat(43);
  const s1 = await login.login({ code: 'abc', codeVerifier: verifier, redirectUri: 'https://web.example.org/auth/callback' });
  eq(posts[0].url, 'https://hydra.faforever.com/oauth2/token', 'user login: the code is exchanged at Hydra');
  eq(posts[0].form.grant_type, 'authorization_code', 'user login: authorization code grant');
  eq(posts[0].form.code_verifier, verifier, 'user login: PKCE verifier is passed on');
  eq(posts[0].form.client_id, 'web-client', 'user login: as the public client');
  ok(!('client_secret' in posts[0].form), 'user login: no secret is involved');
  eq(s1.user.name, 'Nuggets', 'user login: the name comes from the token');
  eq(s1.user.id, '4242', 'user login: and the id');
  eq(s1.chatToken, 'irc-token', 'user login: a chat token is fetched');
  eq(s1.refreshToken, 'r2', 'user login: the refresh token goes back to the browser');
  ok(!('accessToken' in s1) && !JSON.stringify(s1).includes(fakeJwt({ sub: '4242', ext: { username: 'Nuggets' } })),
    'user login: the access token never reaches the browser');
  eq(gets.length, 1, 'user login: no API call needed when the token names the user');

  const s2 = await login.refresh({ refreshToken: 'r1' });
  eq(posts[1].form.grant_type, 'refresh_token', 'user login: refresh uses the refresh grant');
  eq(posts[1].form.refresh_token, 'r1', 'user login: with the browser\'s refresh token');
  eq(s2.chatToken, 'irc-token', 'user login: refresh hands out a fresh chat token');

  async function code(fn) { try { await fn(); return 'none'; } catch (err) { return err.status + ' ' + err.code; } }
  eq(await code(() => login.login({ code: 'abc', codeVerifier: 'short', redirectUri: 'https://x.org/auth/callback' })),
    '400 bad-request', 'user login: a malformed verifier is refused before Hydra');
  eq(await code(() => login.login({ code: 'abc', codeVerifier: verifier, redirectUri: 'https://evil.org/steal' })),
    '400 bad-request', 'user login: only this site\'s callback is accepted as redirect');
  eq(await code(() => login.refresh({})), '400 bad-request', 'user login: refresh needs a token');
  tokenReply = { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) };
  eq(await code(() => login.refresh({ refreshToken: 'old' })), '401 session-expired', 'user login: a dead refresh token means log in again');
  eq(await code(() => login.login({ code: 'used', codeVerifier: verifier, redirectUri: 'https://x.org/auth/callback' })),
    '401 login-rejected', 'user login: a used code is reported as rejected');
  tokenReply = { status: 503, body: 'down' };
  eq(await code(() => login.refresh({ refreshToken: 'x' })), '502 login-failed', 'user login: Hydra trouble is a 502');

  ok(validRedirect('http://localhost:8098/auth/callback'), 'user login: local testing on localhost works');
  ok(!validRedirect('http://web.example.org/auth/callback'), 'user login: plain http is refused off localhost');
  ok(!validRedirect('https://web.example.org/auth/callback?x=1'), 'user login: no extra query on the callback');
  eq(jwtClaims('not-a-jwt'), null, 'user login: non-JWT tokens are handled');

  const viaApi = createUserLogin({
    postImpl: async () => ({ status: 200, body: JSON.stringify({ access_token: 'opaque', refresh_token: 'r' }) }),
    getImpl: async (url) => url.endsWith('/me')
      ? { status: 200, body: JSON.stringify({ data: { id: '7', attributes: { userName: 'Sera', userId: 7 } } }) }
      : { status: 200, body: JSON.stringify({ value: 't' }) }
  });
  const s3 = await viaApi.refresh({ refreshToken: 'r' });
  eq(s3.user.name, 'Sera', 'user login: falls back to /me for an opaque token');

  const noChat = createUserLogin({
    postImpl: async () => ({ status: 200, body: JSON.stringify({ access_token: 'opaque' }) }),
    getImpl: async () => ({ status: 403, body: '' })
  });
  eq(await code(() => noChat.refresh({ refreshToken: 'r' })), '502 login-failed', 'user login: unknown user is an error, not a nameless session');
}

/* ----------------------------------------------------------- base domain */

function testBaseDomain() {
  // A fresh process per setting: the host names are fixed when the modules load.
  function hostsWith(domain, extraEnv) {
    const script = `
      const { resolve } = require('./lib/upstreams');
      const { boardTarget } = require('./lib/leaderboard');
      const { DEFAULT_TOKEN_URL } = require('./lib/faftoken');
      const login = require('./lib/userlogin').createUserLogin().config();
      console.log(JSON.stringify({
        api: resolve('faf', 'map', '').url,
        lobby: resolve('lobby', 'games', '').url,
        tourney: resolve('tourney', 'tournaments', '').url,
        board: boardTarget('global').url,
        token: DEFAULT_TOKEN_URL,
        authorize: login.login.authorizeUrl,
        chat: login.chat.url,
        user: require('./lib/hosts').serverUrl('user'),
        transport: require('./lib/hosts').transport('http://faf-api:8010') === require('http')
      }));`;
    const out = spawnSync(process.execPath, ['-e', script], {
      cwd: __dirname, encoding: 'utf8', env: Object.assign({}, process.env, { FAF_BASE_DOMAIN: domain }, extraEnv || {})
    });
    return out.status === 0 ? JSON.parse(out.stdout) : { failed: out.stderr };
  }

  const test = hostsWith('faforever.xyz');
  eq(test.api, 'https://api.faforever.xyz/data/map', 'base domain: the test site reads the test API');
  eq(test.lobby, 'https://lobby.faforever.xyz/games', 'base domain: and the test lobby server');
  eq(test.tourney, 'https://tournaments.faforever.xyz/api/tournaments', 'base domain: and test tournaments');
  eq(test.board, 'https://www.faforever.xyz/leaderboards/global.json', 'base domain: and the test website');
  eq(test.token, 'https://hydra.faforever.xyz/oauth2/token', 'base domain: service login at the test Hydra');
  eq(test.authorize, 'https://hydra.faforever.xyz/oauth2/auth', 'base domain: player login at the test Hydra');
  eq(test.chat, 'wss://chat.faforever.xyz', 'base domain: chat on the test chat server');

  const unset = hostsWith('');
  eq(unset.api, 'https://api.faforever.com/data/map', 'base domain: unset means faforever.com');

  // In FAF's cluster the server skips Cloudflare and calls the services
  // directly; the browser keeps the public addresses.
  const cluster = hostsWith('faforever.com', { KUBERNETES_SERVICE_HOST: '10.0.0.1' });
  eq(cluster.api, 'http://faf-api:8010/data/map', 'in cluster: the API by its internal name');
  eq(cluster.tourney, 'http://faf-tournaments:8090/api/tournaments', 'in cluster: tournaments by internal name');
  eq(cluster.board, 'http://faf-website:3000/leaderboards/global.json', 'in cluster: the website by internal name');
  eq(cluster.token, 'http://ory-hydra:4444/oauth2/token', 'in cluster: tokens from Hydra directly');
  eq(cluster.user, 'http://faf-user-service:8080', 'in cluster: chat tokens from the user service directly');
  eq(cluster.authorize, 'https://hydra.faforever.com/oauth2/auth', 'in cluster: the browser still logs in on the public page');
  eq(cluster.chat, 'wss://chat.faforever.com', 'in cluster: the browser still chats on the public address');
  eq(cluster.lobby, 'https://lobby.faforever.com/games', 'in cluster: no internal name assumed for the lobby');
  ok(cluster.transport === true, 'in cluster: plain http is used for internal addresses');
  const forced = hostsWith('faforever.com', { KUBERNETES_SERVICE_HOST: '10.0.0.1', FAF_API_URL: 'http://api.internal:9000/' });
  eq(forced.api, 'http://api.internal:9000/data/map', 'override: an address set by hand wins');
  const badOverride = hostsWith('faforever.com', { FAF_API_URL: 'http://x/evil?y' });
  ok(badOverride.failed && /FAF_API_URL/.test(badOverride.failed), 'override: a malformed address refuses to start');

  const bad = hostsWith('evil.example/x');
  ok(bad.failed && /FAF_BASE_DOMAIN/.test(bad.failed), 'base domain: anything but a domain name refuses to start');
}

/* ----------------------------------------------------------- leaderboard */
function testLeaderboard() {
  eq(boardTarget('global').url, 'https://www.faforever.com/leaderboards/global.json', 'leaderboard: global maps to faforever.com');
  eq(boardTarget('4v4').url, 'https://www.faforever.com/leaderboards/4v4.json', 'leaderboard: 4v4 maps to faforever.com');
  eq(boardTarget('../x'), null, 'leaderboard: anything off the list is refused');
  eq(boardTarget('constructor'), null, 'leaderboard: prototype names are refused');

  const rows = [];
  for (let i = 0; i < 120; i++) {
    rows.push({ playerId: i, rating: 2000 - i + 0.4, totalgames: 100 + i, wonGames: 50, date: 'x', label: i === 77 ? 'Nuggets' : 'player' + i });
  }
  const body = Buffer.from(JSON.stringify(rows));

  const p1 = pageOf(body, {});
  eq(p1.total, 120, 'leaderboard: counts every player');
  eq(p1.pages, Math.ceil(120 / PAGE_SIZE), 'leaderboard: page count');
  eq(p1.rows.length, PAGE_SIZE, 'leaderboard: one page of rows');
  eq(p1.rows[0].rank + '/' + p1.rows[0].rating, '1/2000', 'leaderboard: rank and rounded rating');

  const last = pageOf(body, { page: '99' });
  eq(last.page, last.pages, 'leaderboard: a page past the end clamps to the last page');
  eq(pageOf(body, { page: 'abc' }).page, 1, 'leaderboard: a junk page number means page 1');

  const found = pageOf(body, { query: 'NUGG' });
  eq(found.total, 1, 'leaderboard: search is case-insensitive');
  eq(found.rows[0].rank, 78, 'leaderboard: search keeps the real rank');
  eq(pageOf(body, { query: 'nobody' }).total, 0, 'leaderboard: no match is an empty page');

  // The API path, used when the service login is configured.
  const now = Date.UTC(2026, 10, 11, 15, 30);
  const t = apiTarget('3v3', { page: '2', query: 'nu"gg*', now });
  const u = t && new URL(t.url);
  ok(u && u.origin + u.pathname === 'https://api.faforever.com/data/leaderboardRating', 'leaderboard api: hits leaderboardRating', t && t.url);
  eq(u && u.searchParams.get('filter'),
    'leaderboard.id==6;updateTime=ge=2025-11-11T00:00:00.000Z;player.login=="*nugg*"',
    'leaderboard api: faforever.com\'s board id, a day-rounded 12-month window, a sanitised search');
  eq(u && u.searchParams.get('page[number]'), '2', 'leaderboard api: asks for the requested page');
  eq(apiTarget('global', { now: now + 3600_000 }).url, apiTarget('global', { now }).url, 'leaderboard api: the URL is stable within a day, so it caches');
  eq(apiTarget('5v5', { now }), null, 'leaderboard api: unknown boards are refused');

  const apiBody = Buffer.from(JSON.stringify({
    data: [
      { id: '10', type: 'leaderboardRating', attributes: { rating: 1999.6, totalGames: 40, wonGames: 30 }, relationships: { player: { data: { id: '7', type: 'player' } } } },
      { id: '11', type: 'leaderboardRating', attributes: { rating: 1900.2, totalGames: 10, wonGames: 2 }, relationships: { player: { data: { id: '8', type: 'player' } } } }
    ],
    included: [{ id: '7', type: 'player', attributes: { login: 'Nuggets' } }, { id: '8', type: 'player', attributes: { login: 'Deli' } }],
    meta: { page: { totalRecords: 1234, totalPages: 25 } }
  }));
  const ap = pageFromApi(apiBody, { page: 3 });
  eq(ap.total + '/' + ap.pages, '1234/25', 'leaderboard api: totals come from the page meta');
  eq(ap.rows[0].rank + ' ' + ap.rows[0].name + ' ' + ap.rows[0].rating, (2 * PAGE_SIZE + 1) + ' Nuggets 2000', 'leaderboard api: rank follows the page, names resolve, rating rounds');
  eq(pageFromApi(apiBody, { page: 1, query: 'nug' }).rows[0].rank, null, 'leaderboard api: a search result has no known rank');
}

/* ------------------------------------------------ static paths (security) */

function testStaticPaths() {
  const root = path.resolve(__dirname, 'public');
  ok(resolveFile(root, '/index.html') !== null, 'static: index.html resolves');
  ok(resolveFile(root, '/') !== null, 'static: / resolves to the index');
  eq(resolveFile(root, '/../server.js'), null, 'static: traversal out of public/ is refused');
  eq(resolveFile(root, '/../../etc/passwd'), null, 'static: deep traversal is refused');
  eq(resolveFile(root, '/%2e%2e/server.js'), null, 'static: encoded traversal is refused');
  eq(resolveFile(root, '/app.js%00.png'), null, 'static: a null byte is refused');
  eq(resolveFile(root, '/does-not-exist.css'), null, 'static: a missing file is null');

  // The app is a Vite build: hashed bundles under public/assets.
  const bundle = fs.readdirSync(path.join(root, 'assets')).find((f) => f.endsWith('.js'));
  const js = bundle && resolveFile(root, '/assets/' + bundle);
  ok(js && /text\/javascript/.test(js.type), 'static: the app bundle gets a javascript content type');
}

/* -------------------------------------------------------- proxy behaviour */

async function testProxy() {
  const cache = createCache();
  let calls = 0;
  let seenOpts = null;

  const stub = (url, opts) => {
    calls++;
    seenOpts = opts;
    return Promise.resolve({
      status: 200,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ url, n: calls }))
    });
  };

  const target = { url: 'https://api.faforever.com/data/map', ttlMs: 1000 };

  const a = await proxyGet(target, cache, { fetchImpl: stub });
  eq(a.status, 200, 'proxy: a good upstream returns 200');
  eq(a.cached, false, 'proxy: the first call is a miss');

  const b = await proxyGet(target, cache, { fetchImpl: stub });
  eq(b.cached, true, 'proxy: the second call is served from cache');
  eq(calls, 1, 'proxy: the upstream was called exactly once');

  // No credentials may ever be forwarded. This asserts on the REAL header set
  // the outgoing request uses, not on what the stub happened to receive. The
  // earlier version inspected the stub's arguments and therefore passed even
  // when an Authorization header was planted in the real request.
  const hdrNames = Object.keys(UPSTREAM_HEADERS);
  ok(!hdrNames.some((h) => /cookie|authorization|x-api-key|token/i.test(h)),
    'proxy: the upstream request carries no credential header', hdrNames.join(','));
  eq(hdrNames.length, 2, 'proxy: the upstream header set is exactly User-Agent and Accept');
  ok(seenOpts !== null, 'proxy: the stub was actually invoked');

  // Expiry.
  const shortCache = createCache();
  await proxyGet({ url: 'https://api.faforever.com/data/mod', ttlMs: 1 }, shortCache, { fetchImpl: stub });
  await new Promise((r) => setTimeout(r, 20));
  const after = await proxyGet({ url: 'https://api.faforever.com/data/mod', ttlMs: 1 }, shortCache, { fetchImpl: stub });
  eq(after.cached, false, 'proxy: an expired entry is refetched');

  // Upstream failures are reported, not cached.
  const errCache = createCache();
  const failing = () => Promise.resolve({
    status: 503, contentType: 'application/json', body: Buffer.from('{"errors":[{"detail":"down"}]}')
  });
  const e1 = await proxyGet(target, errCache, { fetchImpl: failing });
  eq(e1.status, 503, 'proxy: an upstream error status is passed through');
  const e2 = await proxyGet(target, errCache, { fetchImpl: failing });
  eq(e2.cached, false, 'proxy: failures are never cached');

  // An HTML error page is not forwarded to the browser.
  const htmlErr = () => Promise.resolve({
    status: 500, contentType: 'text/html', body: Buffer.from('<html>stack trace</html>')
  });
  const h = await proxyGet(target, createCache(), { fetchImpl: htmlErr });
  ok(!h.body.toString().includes('stack trace'), 'proxy: an upstream HTML error body is not forwarded');

  // A thrown error becomes a clean 502/504 rather than a crash.
  const boom = () => Promise.reject(Object.assign(new Error('nope'), { timeout: true }));
  const t504 = await proxyGet(target, createCache(), { fetchImpl: boom });
  eq(t504.status, 504, 'proxy: an upstream timeout becomes a 504');

  // The cache is bounded.
  const small = createCache(3);
  for (let i = 0; i < 10; i++) {
    await proxyGet({ url: 'https://api.faforever.com/data/map?i=' + i, ttlMs: 1000 }, small, { fetchImpl: stub });
  }
  ok(small.size() <= 3, 'proxy: the cache is bounded', 'size=' + small.size());
}

/* ----------------------------------------------------------- the real server */

function request(port, p, method, body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET', headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function startServer() {
  const port = 21000 + Math.floor(Math.random() * 10000);
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    // The deployment's own settings must not change what the suite expects:
    // it also runs inside the container, before every auto-update.
    env: Object.assign({}, process.env, { PORT: String(port), FAF_API_CLIENT_ID: '', FAF_API_CLIENT_SECRET: '', FAF_LOGIN_CLIENT_ID: '', FAF_BASE_DOMAIN: '' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = setInterval(() => {
      if (out.includes('"msg":"listening"')) {
        clearInterval(tick);
        resolve({
          port, proc, logs: () => out,
          stop: () => new Promise((r) => { proc.once('close', r); proc.kill('SIGTERM'); })
        });
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        reject(new Error('server did not start: ' + out));
      }
    }, 40);
  });
}

async function testServer() {
  const s = await startServer();
  try {
    const health = await request(s.port, '/healthz');
    eq(health.status, 200, 'server: /healthz answers');
    const hj = JSON.parse(health.body);
    eq(hj.ok, true, 'server: health reports ok');
    eq(hj.playTab, true, 'server: health reports the Play tab (open lobbies)');
    eq(hj.serviceLogin, false, 'server: health reports the service login as not configured');
    eq(hj.chatLogin, true, 'server: health reports the chat login as on');

    const config = await request(s.port, '/api/config');
    eq(config.status, 200, 'server: /api/config answers');
    const cj = JSON.parse(config.body);
    ok(cj.login && typeof cj.login.clientId === 'string', 'server: config carries the login client');
    eq(cj.chat && cj.chat.channel, '#aeolus', 'server: config names the default channel');
    eq(cj.baseDomain, 'faforever.com', 'server: config tells the site which FAF it belongs to');
    ok(cj.link && cj.link.path === '/api/link' && Buffer.from(cj.link.pushKey || '', 'base64url').length === 65,
      'server: config names the PC link and its push key', JSON.stringify(cj.link));
    eq(hj.link && hj.link.pcs, 0, 'server: health counts connected PCs');

    // The PC link's routes.
    const pushGet = await request(s.port, '/api/link/push');
    eq(pushGet.status, 405, 'server: push sign-up only takes POST');
    const pushNoTicket = await request(s.port, '/api/link/push', 'POST', JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a', auth: 'b' } } }), { 'Content-Type': 'application/json' });
    eq(pushNoTicket.status, 401, 'server: push sign-up needs a link ticket');
    const otherUpgrade = await new Promise((resolve) => {
      const r = http.request({ port: s.port, host: '127.0.0.1', path: '/api/faf/map', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } });
      r.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      r.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
      r.on('error', () => resolve(0));
      r.end();
    });
    eq(otherUpgrade, 404, 'server: nothing but the PC link upgrades to a WebSocket');
    const pc = await wsClient(s.port);
    ok(!pc.failed, 'server: the PC link accepts WebSockets');
    pc.send2({ type: 'hello', role: 'pc', version: 1, token: 'not-a-jwt' });
    eq((await pc.next('error') || {}).code, 'token', 'server: and checks the PC\'s FAF token');
    pc.close();

    const json = { 'Content-Type': 'application/json' };
    const getLogin = await request(s.port, '/api/auth/login');
    eq(getLogin.status, 405, 'server: login only takes POST');
    const unknownAuth = await request(s.port, '/api/auth/steal', 'POST', '{}', json);
    eq(unknownAuth.status, 404, 'server: unknown auth actions are 404');
    const notJson = await request(s.port, '/api/auth/login', 'POST', 'code=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
    eq(notJson.status, 415, 'server: login only takes JSON');
    const badJson = await request(s.port, '/api/auth/login', 'POST', '{nope', json);
    eq(badJson.status, 400, 'server: broken JSON is a 400');
    const empty = await request(s.port, '/api/auth/login', 'POST', '{}', json);
    eq(empty.status, 400, 'server: a login without a code is refused before reaching FAF');
    eq(JSON.parse(empty.body).code, 'bad-request', 'server: and says so');
    eq(empty.headers['cache-control'], 'no-store', 'server: auth answers are never cached');
    const huge = await request(s.port, '/api/auth/refresh', 'POST', JSON.stringify({ refreshToken: 'x'.repeat(20000) }), json);
    eq(huge.status, 413, 'server: oversized auth bodies are refused');
    const logout = await request(s.port, '/api/auth/logout', 'POST', '{}', json);
    eq(logout.status, 200, 'server: logout always succeeds for the browser');

    const maps = await request(s.port, '/api/faf/map?page%5Bsize%5D=1');
    eq(maps.status, 503, 'server: FAF API reads without a service login answer 503');
    eq(JSON.parse(maps.body).code, 'service-login-missing', 'server: and say why, so the page can explain it');

    const lb = await request(s.port, '/api/leaderboard/nope');
    eq(lb.status, 404, 'server: an unknown leaderboard is a 404');

    const index = await request(s.port, '/');
    eq(index.status, 200, 'server: the app shell is served');
    ok(/text\/html/.test(index.headers['content-type']), 'server: the shell is HTML');
    ok(index.body.includes('id="root"'), 'server: the shell contains the app mount point');

    const spa = await request(s.port, '/leaderboard');
    eq(spa.status, 200, 'server: an app route falls back to the shell');
    ok(spa.body.includes('id="root"'), 'server: the fallback really is the shell');

    const missingAsset = await request(s.port, '/nope.css');
    eq(missingAsset.status, 404, 'server: a missing asset is a 404, not the shell');

    const cssHref = (index.body.match(/href="(\/assets\/[^"?]+\.css(?:\?v=[0-9a-f]+)?)"/) || [])[1];
    ok(Boolean(cssHref), 'server: the shell links the built stylesheet', cssHref);
    ok(/\?v=[0-9a-f]{10}$/.test(cssHref || ''), 'server: the stylesheet link carries its version, so no cache pairs old files with a new page', cssHref);
    const css = await request(s.port, cssHref || '/missing.css');
    eq(css.status, 200, 'server: the stylesheet is served');
    ok(/text\/css/.test(css.headers['content-type']), 'server: the stylesheet has the right type');

    // Security headers.
    const csp = index.headers['content-security-policy'] || '';
    ok(/script-src 'self'/.test(csp), 'server: CSP restricts scripts to this origin');
    ok(/frame-src[^;]*faforever\.github\.io/.test(csp), 'server: CSP allows the embedded FAF pages');
    ok(/frame-src[^;]*https:\/\/unitdb\.faforever\.com/.test(csp), 'server: CSP allows the unit database');
    ok(/frame-src[^;]*https:\/\/daily\.faforever\.com/.test(csp), 'server: CSP allows FAF Daily');
    ok(!/frame-src[^;]*\*/.test(csp), 'server: CSP does not allow framing anything');
    ok(/connect-src 'self' wss:\/\/chat\.faforever\.com wss:\/\/webclient\.faforever\.com(;|$)/.test(csp), 'server: CSP lets the page reach FAF chat and its own PC link, nothing else');
    eq(index.headers['x-content-type-options'], 'nosniff', 'server: nosniff is set');

    // API surface.
    const unknownRoute = await request(s.port, '/api/nope/x');
    eq(unknownRoute.status, 404, 'server: an unknown proxy route is 404');

    const blockedResource = await request(s.port, '/api/faf/secretThing');
    eq(blockedResource.status, 404, 'server: a non-allowlisted resource is 404');
    eq(blockedResource.body, unknownRoute.body,
      'server: blocked and unknown answer identically, so the allowlist cannot be enumerated');

    const post = await request(s.port, '/api/faf/map', 'POST');
    eq(post.status, 405, 'server: the proxy refuses anything but GET');
    ok((post.headers.allow || '').includes('GET'), 'server: the 405 names the allowed method');

    const traversal = await request(s.port, '/../server.js');
    ok(traversal.status === 404 || traversal.status === 400,
      'server: traversal does not escape public/', String(traversal.status));
    ok(!traversal.body.includes('require('), 'server: no source file leaked');

    await new Promise((r) => setTimeout(r, 150));
    ok(!s.logs().includes('Authorization'), 'server: nothing auth-shaped is logged');
  } finally {
    await s.stop();
  }
}


/* ------------------------------------------------------------- auto-update */

const VERIFY_FILES = ['server.js', 'lib/proxy.js', 'lib/static.js', 'lib/upstreams.js',
  'lib/watcher.js', 'lib/faftoken.js', 'lib/leaderboard.js', 'lib/userlogin.js', 'lib/hosts.js',
  'lib/link.js', 'lib/jwt.js', 'lib/webpush.js', 'lib/websocket.js', 'webtest.js'];

/**
 * Stub git/node. On `git clone` it really creates the files verify() looks for,
 * so the existsSync loop and the control flow are exercised for real; only the
 * network and the child processes are faked.
 */
function makeExec(opts) {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push(cmd + ' ' + args.join(' '));
      const joined = args.join(' ');
      if (joined.includes('rev-parse')) return opts.local;
      if (joined.includes('ls-remote')) {
        if (opts.remoteRaw !== undefined) return opts.remoteRaw;
        return opts.remote + '\trefs/heads/main';
      }
      if (joined.includes('remote get-url')) return 'https://x-access-token:TOK@github.com/o/r.git';
      if (args[0] === 'clone') {
        const dest = args[args.length - 1];
        for (const f of VERIFY_FILES) {
          fs.mkdirSync(path.join(dest, path.dirname(f)), { recursive: true });
          fs.writeFileSync(path.join(dest, f), '// stub\n');
        }
        if (opts.cloneFails) throw Object.assign(new Error('clone failed'), { stderr: 'fatal: could not read' });
        return '';
      }
      if (joined.includes('--check')) {
        if (opts.syntaxFails) throw Object.assign(new Error('bad syntax'), { stderr: 'SyntaxError: unexpected token' });
        return '';
      }
      if (joined.includes('webtest.js')) {
        if (opts.testsFail) throw Object.assign(new Error('tests failed'), { stderr: '3 passed, 2 failed' });
        return '59 passed, 0 failed';
      }
      if (opts.throwAll) throw new Error('git exploded');
      return '';
    }
  };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

async function testWatcher() {
  // The whole userinfo goes, not just the password - the username half of a
  // GitHub token URL is not worth keeping and redacting less is a worse default.
  eq(redactUrl('https://x-access-token:SECRET@github.com/o/r.git'),
    'https://***@github.com/o/r.git',
    'watcher: credentials are redacted before logging');
  ok(!redactUrl('https://x-access-token:SECRET@github.com/o/r.git').includes('SECRET'),
    'watcher: the token itself never survives redaction');

  // Nothing to do.
  let deployed = 0;
  let h = makeExec({ local: SHA_A, remote: SHA_A });
  let w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 0, 'watcher: an unchanged remote does not restart');
  eq(w.status().last, 'up to date', 'watcher: status says up to date');
  ok(!h.calls.some((c) => c.startsWith('git clone')), 'watcher: no clone when nothing changed');

  // A good update deploys.
  deployed = 0;
  h = makeExec({ local: SHA_A, remote: SHA_B });
  w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 1, 'watcher: a verified update triggers exactly one restart');
  ok(h.calls.some((c) => c.includes('webtest.js')), 'watcher: the suite really is run before deploying');

  // A commit that fails the tests must NOT deploy.
  deployed = 0;
  h = makeExec({ local: SHA_A, remote: SHA_B, testsFail: true });
  w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 0, 'watcher: a commit that fails the suite is NOT deployed');
  ok(/rejected/.test(w.status().last), 'watcher: status reports the rejection', w.status().last);

  // A commit with a syntax error must NOT deploy.
  deployed = 0;
  h = makeExec({ local: SHA_A, remote: SHA_B, syntaxFails: true });
  w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 0, 'watcher: a commit that fails the syntax check is NOT deployed');

  // A rejected revision is judged once, not re-tested every minute.
  deployed = 0;
  h = makeExec({ local: SHA_A, remote: SHA_B, testsFail: true });
  w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  const clonesAfterFirst = h.calls.filter((c) => c.startsWith('git clone')).length;
  await w.tick();
  await w.tick();
  const clonesAfterThird = h.calls.filter((c) => c.startsWith('git clone')).length;
  eq(clonesAfterFirst, 1, 'watcher: the bad revision was verified once');
  eq(clonesAfterThird, 1, 'watcher: it is not re-verified on every tick');
  eq(deployed, 0, 'watcher: still not deployed');

  // But a NEWER commit after a bad one does get a fresh chance.
  deployed = 0;
  let stage = { local: SHA_A, remote: SHA_B, testsFail: true };
  const dynamic = {
    calls: [],
    exec: async (cmd, args) => {
      const inner = makeExec(stage);
      const out = await inner.exec(cmd, args);
      dynamic.calls.push(...inner.calls);
      return out;
    }
  };
  w = createWatcher({ exec: dynamic.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 0, 'watcher: the broken commit is held back');
  stage = { local: SHA_A, remote: SHA_C, testsFail: false };
  await w.tick();
  eq(deployed, 1, 'watcher: a later fixed commit deploys');

  // Garbage from ls-remote must not deploy anything.
  deployed = 0;
  h = makeExec({ local: SHA_A, remoteRaw: 'not-a-sha whatever' });
  w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 0, 'watcher: an unparseable ls-remote does not restart');

  // A failing git command must not crash or deploy.
  deployed = 0;
  w = createWatcher({
    exec: async () => { throw new Error('network down'); },
    onDeploy: () => { deployed++; }
  });
  await w.tick();
  eq(deployed, 0, 'watcher: a git failure does not restart');
  eq(w.status().last, 'error', 'watcher: the failure is visible in status');

  // A failed clone is a rejection, not a deploy.
  deployed = 0;
  h = makeExec({ local: SHA_A, remote: SHA_B, cloneFails: true });
  w = createWatcher({ exec: h.exec, onDeploy: () => { deployed++; } });
  await w.tick();
  eq(deployed, 0, 'watcher: a failed clone does not restart');
}


/* ------------------------------------------------------------- the PC link */

/** A WebSocket client that collects what it receives, for the link tests. */
function wsClient(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/api/link', headers ? { headers } : undefined);
    const inbox = [];
    const waiters = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      inbox.push(msg);
      for (const w of waiters.splice(0)) w();
    };
    ws.onclose = (event) => { ws.closeCode = event.code; for (const w of waiters.splice(0)) w(); };
    ws.onopen = () => resolve(Object.assign(ws, {
      inbox,
      send2: (value) => ws.send(JSON.stringify(value)),
      // The next message of this type (or the close), within 2 s.
      next: (type) => new Promise((done) => {
        const started = Date.now();
        const look = () => {
          const i = inbox.findIndex((m) => m.type === type);
          if (i >= 0) return done(inbox.splice(i, 1)[0]);
          if (ws.readyState === 3 || Date.now() - started > 2000) return done(null);
          waiters.push(look);
          setTimeout(look, 50);
        };
        look();
      })
    }));
    ws.onerror = () => resolve(Object.assign(ws, { inbox, failed: true }));
  });
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function testLink() {
  // What the browser may ask for, and nothing else.
  eq(JSON.stringify(commandFrom({ action: 'startSearch', queues: ['ladder1v1', 'ladder1v1'] })), '{"action":"startSearch","queues":["ladder1v1"]}', 'link: a search start names queues, once each');
  eq(commandFrom({ action: 'startSearch', queues: [] }), null, 'link: a search needs a queue');
  eq(commandFrom({ action: 'startSearch', queues: ['a b'] }), null, 'link: a queue name is a plain word');
  eq(commandFrom({ action: 'joinGame', gameId: 0 }), null, 'link: a game id is positive');
  eq(commandFrom({ action: 'joinGame', gameId: 1.5 }), null, 'link: a game id is whole');
  eq(JSON.stringify(commandFrom({ action: 'joinGame', gameId: 42, password: 'pw' })), '{"action":"joinGame","gameId":42,"password":"pw"}', 'link: a join can carry a password');
  eq(commandFrom({ action: 'joinGame', gameId: 42, password: 'x'.repeat(101) }), null, 'link: passwords are bounded');
  eq(commandFrom({ action: 'host', title: 'x' }), null, 'link: anything else is refused');
  eq(commandFrom({ action: 'stopSearch' }).action, 'stopSearch', 'link: stopping every search needs no queue');

  // Tokens: a fake verifier standing in for lib/jwt.js.
  const tokens = {
    verify: async (token) => {
      const [kind, sub, name] = String(token).split(':');
      if (kind === 'rust') return { sub, client_id: RUST_CLIENT_ID, ext: { username: name } };
      if (kind === 'legacy') return { sub, client_id: LEGACY_RUST_CLIENT_ID };
      if (kind === 'other') return { sub, client_id: 'some-other-site' };
      throw Object.assign(new Error('token not signed by FAF'), { code: 'bad-signature' });
    }
  };
  const pushed = [];
  const fakePush = { publicKey: 'pk', send: async (sub, message) => { pushed.push({ sub, message }); return { status: 201 }; } };
  let clock = Date.now();
  const link = createLink({ tokens, push: fakePush, secret: 'test-secret', allowedOrigin: (origin) => origin === 'http://site.test', now: () => clock });

  // Tickets.
  const ticket = link.issueTicket({ id: '42', name: 'Ada' });
  eq(JSON.stringify(link.verifyTicket(ticket)), '{"id":"42","name":"Ada"}', 'link: a ticket names its account');
  eq(link.verifyTicket(ticket.slice(0, -2) + 'xx'), null, 'link: a changed ticket is refused');
  const [data, mac] = ticket.split('.');
  const forged = Buffer.from(JSON.stringify({ u: '7', n: 'Eve', e: clock + 1e9 })).toString('base64url') + '.' + mac;
  eq(link.verifyTicket(forged), null, 'link: a ticket for another account cannot reuse a signature');
  clock += 26 * 3600 * 1000;
  eq(link.verifyTicket(ticket), null, 'link: an old ticket expires');
  clock = Date.now();
  ok(data.length > 0, 'link: tickets have a body');

  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => link.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const web = { origin: 'http://site.test' };

  try {
    // A PC without a FAF login, or from another program, is refused.
    const forgedPc = await wsClient(port);
    forgedPc.send2({ type: 'hello', role: 'pc', version: 1, token: 'nonsense' });
    const refused = await forgedPc.next('error');
    eq(refused && refused.code, 'token', 'link: a PC needs a token FAF signed');
    const otherApp = await wsClient(port);
    otherApp.send2({ type: 'hello', role: 'pc', version: 1, token: 'other:42' });
    eq((await otherApp.next('error') || {}).code, 'client', 'link: only the Rust client\'s tokens act as the PC');
    const pageAsPc = await wsClient(port, web);
    pageAsPc.send2({ type: 'hello', role: 'pc', version: 1, token: 'rust:42:Ada' });
    eq((await pageAsPc.next('error') || {}).code, 'origin', 'link: a web page cannot pose as the PC');

    // A browser needs its ticket, and must come from this site.
    const noTicket = await wsClient(port, web);
    noTicket.send2({ type: 'hello', role: 'web', version: 1, ticket: 'x.y' });
    eq((await noTicket.next('error') || {}).code, 'ticket', 'link: a browser needs a ticket');
    const elsewhere = await wsClient(port, { origin: 'http://evil.test' });
    elsewhere.send2({ type: 'hello', role: 'web', version: 1, ticket });
    eq((await elsewhere.next('error') || {}).code, 'origin', 'link: another site cannot use a visitor\'s ticket');

    // The real pairing.
    const pc = await wsClient(port);
    pc.send2({ type: 'hello', role: 'pc', version: 1, token: 'rust:42:Ada', client: 'FAF Rust client 1.0', device: 'DESKTOP' });
    const welcome = await pc.next('welcome');
    eq(welcome && welcome.browsers, 0, 'link: the PC is welcomed, no browser yet');
    pc.send2({ type: 'state', state: { matchmaking: { status: 'idle' } } });
    await settle();

    const browser = await wsClient(port, web);
    browser.send2({ type: 'hello', role: 'web', version: 1, ticket });
    const bw = await browser.next('welcome');
    ok(bw && bw.pc && bw.pc.connected === true && bw.pc.device === 'DESKTOP', 'link: the browser hears its PC is there', JSON.stringify(bw));
    const lateState = await browser.next('state');
    eq(lateState && lateState.state.matchmaking.status, 'idle', 'link: a browser that comes later gets the latest state');
    eq((await pc.next('browsers') || {}).count, 1, 'link: the PC hears a browser is connected');

    browser.send2({ type: 'command', id: 'c1', command: { action: 'startSearch', queues: ['ladder1v1'] } });
    const cmd = await pc.next('command');
    eq(cmd && JSON.stringify(cmd.command), '{"action":"startSearch","queues":["ladder1v1"]}', 'link: the PC receives the command');
    pc.send2({ type: 'result', id: 'c1', ok: true });
    eq((await browser.next('result') || {}).ok, true, 'link: the browser receives the result');

    browser.send2({ type: 'command', id: 'c2', command: { action: 'deleteReplays' } });
    const bad = await browser.next('result');
    ok(bad && bad.ok === false && bad.id === 'c2', 'link: an unknown command is answered, not forwarded');
    eq(pc.inbox.filter((m) => m.type === 'command').length, 0, 'link: nothing unknown reaches the PC');

    // Another account sees none of it.
    const strangerTicket = link.issueTicket({ id: '7', name: 'Eve' });
    const stranger = await wsClient(port, web);
    stranger.send2({ type: 'hello', role: 'web', version: 1, ticket: strangerTicket });
    const sw = await stranger.next('welcome');
    eq(sw && sw.pc.connected, false, 'link: another account does not see this PC');
    stranger.send2({ type: 'command', id: 's1', command: { action: 'startSearch', queues: ['ladder1v1'] } });
    eq((await stranger.next('result') || {}).ok, false, 'link: another account cannot command this PC');
    await settle(100);
    eq(pc.inbox.filter((m) => m.type === 'command').length, 0, 'link: and its command never reaches it');

    // A match found reaches the browser, and the phone.
    eq(link.setPush({ ticket, subscription: { endpoint: 'https://evil.test/x', keys: { p256dh: 'a', auth: 'b' } } }).status, 400, 'link: push only to the browsers\' push services');
    eq(link.setPush({ ticket: 'nope', subscription: {} }).status, 401, 'link: push needs a ticket');
    eq(link.setPush({ ticket, subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'pkey', auth: 'akey' } } }).status, 200, 'link: a phone signs up for notifications');
    pc.send2({ type: 'event', event: 'matchFound', queue: 'ladder1v1' });
    const found = await browser.next('event');
    eq(found && found.event, 'matchFound', 'link: the browser hears the match was found');
    await settle();
    eq(pushed.length, 1, 'link: the phone is notified once');
    ok(pushed[0] && /1v1/.test(pushed[0].message.body), 'link: the notification names the queue', pushed[0] && pushed[0].message.body);

    // One PC per account: a second one takes over.
    const pc2 = await wsClient(port);
    pc2.send2({ type: 'hello', role: 'pc', version: 1, token: 'rust:42:Ada', device: 'LAPTOP' });
    await pc2.next('welcome');
    ok(await pc.next('replaced'), 'link: the older PC is told it was replaced');
    const moved = await browser.next('pc');
    eq(moved && moved.pc.device, 'LAPTOP', 'link: the browser follows the new PC');

    // A Rust client still renewing a login from before it had its own OAuth client.
    const older = await wsClient(port);
    older.send2({ type: 'hello', role: 'pc', version: 1, token: 'legacy:43:Old' });
    ok(await older.next('welcome'), 'link: a Rust client on its earlier OAuth client is accepted');
    older.close();

    pc2.close();
    const gone = await browser.next('pc');
    eq(gone && gone.pc.connected, false, 'link: the browser hears the PC left');
    eq(link.stats().pcs, 0, 'link: no PC is left connected');
    for (const c of [browser, stranger, pc]) c.close();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function testJwt() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1', use: 'sig', alg: 'RS256' });
  let fetches = 0;
  const now = Date.now();
  const verifier = createJwtVerifier({
    jwksUrl: 'https://hydra.example/.well-known/jwks.json',
    issuers: ['https://hydra.example'],
    fetchJson: async () => { fetches++; return { keys: [jwk] }; },
    now: () => now
  });
  const sign = (claims, kid = 'k1', key = privateKey) => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return h + '.' + c + '.' + crypto.sign('RSA-SHA256', Buffer.from(h + '.' + c), key).toString('base64url');
  };
  const good = { iss: 'https://hydra.example/', sub: '42', client_id: RUST_CLIENT_ID, exp: Math.floor(now / 1000) + 600 };
  const claims = await verifier.verify(sign(good));
  eq(claims.sub, '42', 'jwt: a token Hydra signed is read');
  const reason = async (token) => verifier.verify(token).then(() => 'accepted', (err) => err.code);
  eq(await reason(sign(Object.assign({}, good, { exp: Math.floor(now / 1000) - 3600 }))), 'expired', 'jwt: an expired token is refused');
  eq(await reason(sign(Object.assign({}, good, { iss: 'https://evil.example' }))), 'wrong-issuer', 'jwt: another issuer is refused');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  eq(await reason(sign(good, 'k1', other)), 'bad-signature', 'jwt: a token signed by someone else is refused');
  eq(await reason(sign(good, 'k9')), 'unknown-key', 'jwt: an unknown key is refused');
  const unsigned = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(good)).toString('base64url') + '.';
  eq(await reason(unsigned), 'malformed', 'jwt: an unsigned token is refused');
  ok(fetches <= 2, 'jwt: the keys are not fetched for every token', String(fetches));
}

/** RFC 8291 from the receiving side, to check `encrypt` round trips. */
function decryptPush(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const ecdhSecret = uaEcdh.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

async function testWebPush() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  eq(decryptPush(encrypt('{"title":"Match found"}', keys), ua, auth), '{"title":"Match found"}', 'push: the phone can read what was sent');
  ok(allowedEndpoint('https://fcm.googleapis.com/fcm/send/x') && allowedEndpoint('https://web.push.apple.com/abc'), 'push: the browsers\' push services are allowed');
  ok(!allowedEndpoint('https://fcm.googleapis.com.evil.test/') && !allowedEndpoint('http://fcm.googleapis.com/x') && !allowedEndpoint('https://faf-api:8010/x'),
    'push: nothing else is posted to');
  let sent = null;
  const push = createWebPush({ subject: 'https://webclient.example', post: async (url, headers, body) => { sent = { url, headers, body }; return { status: 201 }; } });
  await push.send({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys }, { title: 'x' });
  ok(sent && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(sent.headers.Authorization), 'push: the request is signed', sent && sent.headers.Authorization);
  eq(Buffer.from(push.publicKey, 'base64url').length, 65, 'push: the public key is the raw point the browser expects');
  let threw = false;
  try { await push.send({ endpoint: 'https://evil.test/x', keys }, {}); } catch (_) { threw = true; }
  ok(threw, 'push: an unknown push service is refused before sending');
}

/** The WebSocket server's limits, with hand-made frames. */
async function testWebSocket() {
  const { upgrade } = require('./lib/websocket');
  const server = http.createServer();
  const closes = [];
  const messages = [];
  server.on('upgrade', (req, socket, head) => {
    const conn = upgrade(req, socket, head, { maxMessageBytes: 32 });
    if (!conn) return;
    conn.on('message', (m) => messages.push(m));
    conn.on('close', (code) => closes.push(code));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const net = require('net');
  const raw = (frames) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET /x HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n\r\n');
      setTimeout(() => { for (const f of frames) socket.write(f); }, 50);
      setTimeout(() => { socket.destroy(); resolve(); }, 300);
    });
    socket.on('error', () => {});
  });
  const frame = (text, { masked = true } = {}) => {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    return Buffer.concat([Buffer.from([0x81, (masked ? 0x80 : 0) | payload.length]), masked ? mask : Buffer.alloc(0), body]);
  };
  try {
    await raw([frame('hello')]);
    eq(messages[0], 'hello', 'websocket: a masked text frame is read');
    await raw([frame('x'.repeat(40))]);
    ok(closes.includes(1009), 'websocket: a message over the limit closes the connection', JSON.stringify(closes));
    await raw([frame('hi', { masked: false })]);
    ok(closes.includes(1002), 'websocket: an unmasked frame from a client is refused', JSON.stringify(closes));
    eq(messages.length, 1, 'websocket: nothing from a refused frame is delivered');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/* ------------------------------------------------------------------- main */

(async () => {
  console.log('FAF webclient suite\n');
  const blocks = [
    ['upstream allowlist', testUpstreams],
    ['static paths', testStaticPaths],
    ['proxy', testProxy],
    ['service login', testServiceLogin],
    ['user login', testUserLogin],
    ['base domain', testBaseDomain],
    ['leaderboard', testLeaderboard],
    ['server', testServer],
    ['pc link', testLink],
    ['token check', testJwt],
    ['web push', testWebPush],
    ['websocket', testWebSocket],
    ['auto-update', testWatcher]
  ];
  // WEBTEST_ONLY="pc link,websocket" runs just those blocks.
  const only = (process.env.WEBTEST_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const [name, fn] of blocks) {
    if (only.length && !only.includes(name)) continue;
    const before = fail;
    try { await fn(); } catch (err) {
      fail++;
      failures.push(name + ': block threw -> ' + (err && err.message));
    }
    console.log('  ' + name.padEnd(20) + (fail === before ? 'ok' : 'FAILED'));
  }

  console.log('');
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log('  - ' + f));
    console.log('');
  }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('suite crashed: ' + (err && err.stack));
  process.exit(1);
});
