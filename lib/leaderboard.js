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
 */

const BOARDS = Object.freeze({
  global: 'global',
  '1v1': '1v1',
  '2v2': '2v2',
  '3v3': '3v3',
  '4v4': '4v4'
});

const BASE = 'https://www.faforever.com/leaderboards/';
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

module.exports = { BOARDS, boardTarget, pageOf, PAGE_SIZE };
