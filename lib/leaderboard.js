'use strict';

/**
 * Leaderboards, without a login.
 *
 * www.faforever.com publishes each leaderboard as one public JSON array
 * (FAForever/website, routes/views/leaderboardRouter.js): every player rated in
 * the last 12 months, highest rating first, as
 *   { playerId, rating, totalgames, wonGames, date, label }
 *
 * The global board is several megabytes, too much for a phone on every page
 * turn. So this side fetches it once into the shared cache and hands the
 * browser one page at a time, with search.
 *
 * www.faforever.com sits behind Cloudflare, which may refuse a server's
 * request (403). With the service login configured, pages come straight from
 * FAF's API instead, using the same query faforever.com itself runs
 * (website LeaderboardRepository.js).
 */

const BOARDS = Object.freeze({
  global: 'global',
  '1v1': '1v1',
  '2v2': '2v2',
  '3v3': '3v3',
  '4v4': '4v4'
});

const BASE = 'https://www.faforever.com/leaderboards/';
const API_BASE = 'https://api.faforever.com/data/leaderboardRating';
// faforever.com's own board-name to leaderboard-id mapping (leaderboardRouter.js).
const LEADERBOARD_IDS = Object.freeze({ global: 1, '1v1': 2, '2v2': 3, '4v4': 4, '3v3': 6 });
const API_TTL_MS = 60_000;
const TTL_MS = 5 * 60_000;
const PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 40;

/** Upstream target for a board name, or null for anything not on the list. */
function boardTarget(name) {
  if (!Object.prototype.hasOwnProperty.call(BOARDS, name)) return null;
  return { url: BASE + BOARDS[name] + '.json', ttlMs: TTL_MS };
}

// Parsed rows per cached body, so the JSON is parsed once per cache refresh,
// not once per request.
const parsed = new WeakMap();

function rowsOf(body) {
  let rows = parsed.get(body);
  if (!rows) {
    const data = JSON.parse(body.toString('utf8'));
    if (!Array.isArray(data)) throw new Error('leaderboard is not an array');
    rows = data.map((row, index) => ({
      rank: index + 1,
      playerId: row.playerId,
      name: String(row.label ?? ''),
      rating: typeof row.rating === 'number' ? Math.round(row.rating) : null,
      games: typeof row.totalgames === 'number' ? row.totalgames : null,
      won: typeof row.wonGames === 'number' ? row.wonGames : null
    }));
    parsed.set(body, rows);
  }
  return rows;
}

/** One page of a board, optionally narrowed to names containing `query`. */
function pageOf(body, { page = 1, query = '' } = {}) {
  const all = rowsOf(body);
  const q = String(query).trim().slice(0, MAX_QUERY_LENGTH).toLowerCase();
  const matches = q ? all.filter((row) => row.name.toLowerCase().includes(q)) : all;
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);
  return {
    total: matches.length,
    page: current,
    pages,
    rows: matches.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  };
}

function cleanQuery(query) {
  // Quotes, wildcards and backslashes would change the RSQL filter's meaning.
  return String(query || '').replace(/["*\\]/g, '').trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * The API request for one page, or null for an unknown board. The 12-month
 * window starts at midnight UTC so the URL, and so the cache key, only changes
 * once a day.
 */
function apiTarget(name, { page = 1, query = '', now = Date.now() } = {}) {
  if (!Object.prototype.hasOwnProperty.call(LEADERBOARD_IDS, name)) return null;
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - 12);
  since.setUTCHours(0, 0, 0, 0);
  const filters = ['leaderboard.id==' + LEADERBOARD_IDS[name], 'updateTime=ge=' + since.toISOString()];
  const q = cleanQuery(query);
  if (q) filters.push('player.login=="*' + q + '*"');
  const current = Math.max(1, Math.floor(Number(page) || 1));
  const params = new URLSearchParams({
    include: 'player',
    sort: '-rating',
    filter: filters.join(';'),
    'page[size]': String(PAGE_SIZE),
    'page[number]': String(current),
    'page[totals]': ''
  });
  return { url: API_BASE + '?' + params.toString(), ttlMs: API_TTL_MS };
}

/**
 * Turn an API page into the same shape as pageOf. A search result's place on
 * the full board is not known from one page, so its rank is null.
 */
function pageFromApi(body, { page = 1, query = '' } = {}) {
  const doc = JSON.parse(body.toString('utf8'));
  if (!doc || !Array.isArray(doc.data)) throw new Error('leaderboard page has no data');
  const players = new Map();
  for (const item of doc.included || []) {
    if (item && item.type === 'player') players.set(item.id, item);
  }
  const current = Math.max(1, Math.floor(Number(page) || 1));
  const searching = Boolean(cleanQuery(query));
  const meta = (doc.meta && doc.meta.page) || {};
  return {
    total: typeof meta.totalRecords === 'number' ? meta.totalRecords : doc.data.length,
    page: current,
    pages: Math.max(1, typeof meta.totalPages === 'number' ? meta.totalPages : current),
    rows: doc.data.map((item, index) => {
      const a = item.attributes || {};
      const playerId = item.relationships && item.relationships.player && item.relationships.player.data
        ? item.relationships.player.data.id : null;
      const player = playerId != null ? players.get(playerId) : null;
      return {
        rank: searching ? null : (current - 1) * PAGE_SIZE + index + 1,
        playerId: playerId != null ? Number(playerId) : null,
        name: String((player && player.attributes && player.attributes.login) || 'unknown'),
        rating: typeof a.rating === 'number' ? Math.round(a.rating) : null,
        games: typeof a.totalGames === 'number' ? a.totalGames : null,
        won: typeof a.wonGames === 'number' ? a.wonGames : null
      };
    })
  };
}

module.exports = { BOARDS, boardTarget, pageOf, apiTarget, pageFromApi, PAGE_SIZE };
