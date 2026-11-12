// The replay search, as the Rust client builds it
// (crates/faf-domain/src/protocol/replay_query.rs): every filter of its
// online replay vault, turned into the RSQL filter of FAF's API `/data/game`.
//
// Kept from there, because each was a bug once:
// - Ratings are offset by +300: the API has the raw mean (`meanBefore`), and
//   players think in displayed rating (mean - 3 * deviation).
// - A wildcard only works at the ends of a value, so a search is the longest
//   run of characters between the ones RSQL cannot take (Seton's -> *Seton*).
// - A date-only bound is refused: dates become full instants.
// - "Recent only" is an explicit date bound. Without one, a filtered search
//   can keep FAF's database busy for tens of seconds.

export type SortField = "startTime" | "replayTicks" | "reviewsSummary.averageScore" | "name" | "id";

export const SORTS: { id: SortField; label: string }[] = [
  { id: "startTime", label: "Date played" },
  { id: "replayTicks", label: "Duration" },
  { id: "reviewsSummary.averageScore", label: "Review score" },
  { id: "name", label: "Title" },
  { id: "id", label: "Replay ID" },
];

export const GAME_TYPES = [
  { id: "faf", label: "FAF" },
  { id: "fafbeta", label: "FAF Beta" },
  { id: "fafdevelop", label: "FAF Develop" },
  { id: "nomads", label: "Nomads" },
];

export const FACTIONS = [
  { id: "UEF", label: "UEF" },
  { id: "AEON", label: "Aeon" },
  { id: "CYBRAN", label: "Cybran" },
  { id: "SERAPHIM", label: "Seraphim" },
  { id: "NOMAD", label: "Nomad" },
];

// The game's names for the victory conditions (Rust: replays.filters.victory.*).
export const VICTORY_CONDITIONS = [
  { id: "DEMORALIZATION", label: "Assassination" },
  { id: "DOMINATION", label: "Supremacy" },
  { id: "ERADICATION", label: "Annihilation" },
  { id: "SANDBOX", label: "Sandbox" },
];

export const COOP = "coop";
/** Games shorter than this are mostly abandoned lobbies ("Skip short games"). */
export const SHORT_GAME_MINUTES = 5;

const RATING_MEAN_OFFSET = 300;
const TICKS_PER_MINUTE = 600;
const MAP_PIXELS_PER_KM = 51.2;

export interface ReplayQuery {
  player: string;
  exactPlayer: boolean;
  map: string;
  replayId: string;
  /** A rating board's technical name, "coop", or "" for any. */
  mode: string;
  /** A featured mod (faf, fafbeta, ...) or "". */
  gameType: string;
  /** YYYY-MM-DD or "". */
  after: string;
  before: string;
  /** With no `after`: the last year only. Off: all of FAF's history, which is slower. */
  recentOnly: boolean;
  skipShort: boolean;
  sortBy: SortField;
  sortDescending: boolean;
  // Ranges, as typed: a number, or "" for no bound.
  minRating: string;
  maxRating: string;
  minDuration: string;
  maxDuration: string;
  minPlayers: string;
  maxPlayers: string;
  minSizeKm: string;
  maxSizeKm: string;
  minReview: string;
  // More filters
  title: string;
  host: string;
  mapAuthor: string;
  faction: string;
  victory: string;
  minSlots: string;
  maxSlots: string;
  onlyRanked: boolean;
  rankedMapOnly: boolean;
}

export const EMPTY_QUERY: ReplayQuery = {
  player: "",
  exactPlayer: true,
  map: "",
  replayId: "",
  mode: "",
  gameType: "",
  after: "",
  before: "",
  recentOnly: true,
  skipShort: false,
  sortBy: "startTime",
  sortDescending: true,
  minRating: "",
  maxRating: "",
  minDuration: "",
  maxDuration: "",
  minPlayers: "",
  maxPlayers: "",
  minSizeKm: "",
  maxSizeKm: "",
  minReview: "",
  title: "",
  host: "",
  mapAuthor: "",
  faction: "",
  victory: "",
  minSlots: "",
  maxSlots: "",
  onlyRanked: false,
  rankedMapOnly: false,
};

/** The fields under "More filters", for the count on its button. */
export const MORE_FIELDS: (keyof ReplayQuery)[] = ["title", "host", "mapAuthor", "faction", "victory", "minSlots", "maxSlots", "onlyRanked", "rankedMapOnly"];

export function changedCount(query: ReplayQuery, fields: (keyof ReplayQuery)[]): number {
  return fields.filter((field) => query[field] !== EMPTY_QUERY[field]).length;
}

// ---- RSQL pieces

const RESERVED = /["\\*;(),']/;

/** Strips what would break out of a quoted RSQL value; the API has no escaping. */
export function escape(value: string): string {
  return [...value].filter((c) => !RESERVED.test(c)).join("").trim();
}

/** `*longest searchable run*`: the API takes a wildcard only at the ends. */
function glob(value: string): string {
  const longest = value.split(RESERVED).reduce((best, part) => (part.trim().length > best.length ? part.trim() : best), "");
  return longest ? `*${longest}*` : "*";
}

const num = (value: string): number | null => {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function instant(date: string, endOfDay: boolean): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : date;
}

/** YYYY-MM-DD, `days` ago. */
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The digits of a replay id, also out of a pasted replay link. */
export function replayIdFrom(text: string): string {
  return /(\d{1,10})\D*$/.exec(text.trim())?.[1] ?? "";
}

export function buildFilter(q: ReplayQuery): string {
  // Finished games only: a game still running has no replay yet.
  const clauses: string[] = ["endTime=isnull=false"];
  const player = escape(q.player);
  if (player) clauses.push(`playerStats.player.login=="${q.exactPlayer ? player : glob(q.player)}"`);
  if (q.onlyRanked) clauses.push(`validity=="VALID"`);
  if (q.map.trim()) {
    const pattern = glob(q.map);
    clauses.push(`(mapVersion.map.displayName=="${pattern}",mapVersion.folderName=="${pattern}")`);
  }
  if (q.mapAuthor.trim()) clauses.push(`mapVersion.map.author.login=="${glob(q.mapAuthor)}"`);
  if (q.title.trim()) clauses.push(`name=="${glob(q.title)}"`);
  const id = replayIdFrom(q.replayId);
  if (id) clauses.push(`id=="${id}"`);
  if (q.host.trim()) clauses.push(`host.login=="${glob(q.host)}"`);
  if (q.mode === COOP) clauses.push(`featuredMod.technicalName=="${COOP}"`);
  else if (q.mode) clauses.push(`playerStats.ratingChanges.leaderboard.technicalName=="${escape(q.mode)}"`);
  if (q.gameType) clauses.push(`featuredMod.technicalName=="${escape(q.gameType)}"`);
  if (q.faction) clauses.push(`playerStats.faction=="${escape(q.faction)}"`);
  if (q.victory) clauses.push(`victoryCondition=="${escape(q.victory)}"`);

  const minRating = num(q.minRating);
  const maxRating = num(q.maxRating);
  if (minRating !== null) clauses.push(`playerStats.ratingChanges.meanBefore=ge="${minRating + RATING_MEAN_OFFSET}"`);
  if (maxRating !== null) clauses.push(`playerStats.ratingChanges.meanBefore=le="${maxRating + RATING_MEAN_OFFSET}"`);
  const minReview = num(q.minReview);
  if (minReview !== null) clauses.push(`reviewsSummary.averageScore=ge="${minReview}"`);
  const minDuration = num(q.minDuration) ?? (q.skipShort ? SHORT_GAME_MINUTES : null);
  const maxDuration = num(q.maxDuration);
  if (minDuration !== null) clauses.push(`replayTicks=ge="${Math.round(minDuration * TICKS_PER_MINUTE)}"`);
  if (maxDuration !== null) clauses.push(`replayTicks=le="${Math.round(maxDuration * TICKS_PER_MINUTE)}"`);
  const minSlots = num(q.minSlots);
  const maxSlots = num(q.maxSlots);
  if (minSlots !== null) clauses.push(`mapVersion.maxPlayers=ge="${minSlots}"`);
  if (maxSlots !== null) clauses.push(`mapVersion.maxPlayers=le="${maxSlots}"`);
  const minSize = num(q.minSizeKm);
  const maxSize = num(q.maxSizeKm);
  if (minSize !== null) clauses.push(`mapVersion.width=ge="${Math.round(minSize * MAP_PIXELS_PER_KM)}"`);
  if (maxSize !== null) clauses.push(`mapVersion.width=le="${Math.round(maxSize * MAP_PIXELS_PER_KM)}"`);
  if (q.rankedMapOnly) clauses.push(`mapVersion.ranked=="true"`);

  // A replay id is the primary key: no date bound, which would only hide it.
  const after = q.after || (q.recentOnly && !id ? isoDaysAgo(365) : "");
  if (after) clauses.push(`startTime=ge="${instant(after, false)}"`);
  if (q.before) clauses.push(`startTime=le="${instant(q.before, true)}"`);
  return clauses.join(";");
}

export function sortParam(q: ReplayQuery): string {
  return q.sortDescending ? `-${q.sortBy}` : q.sortBy;
}

/** "Players in the game" is a count the API cannot filter on, so it is checked per page. */
export function acceptsPlayerCount(q: ReplayQuery, players: number): boolean {
  const min = num(q.minPlayers);
  const max = num(q.maxPlayers);
  return (min === null || players >= min) && (max === null || players <= max);
}

export const hasLocalFilter = (q: ReplayQuery) => num(q.minPlayers) !== null || num(q.maxPlayers) !== null;
