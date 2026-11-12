// The Events tab's calendar: three sources merged into one list of
// occurrences, the way the Rust client builds it
// (ui/src/features/events/calendarFeed.ts and calendarGrid.ts):
//
//   - the community catalogue (FAForeverRustClient/events, calendar.json),
//     with its weekly and monthly repeats expanded,
//   - tournaments, from the tournament site,
//   - released game patches, from the changelog's index.
//
// Times are Unix seconds in UTC. A timed entry is shown in the reader's own
// zone; an all-day entry is a date, not a moment, so it is read in UTC and
// lands on the same day for everybody.

import type { Release } from "../changelog/parse";

export type Category = "tournament" | "cgn" | "meetup" | "patch" | "ladderPool" | "other";
export type Origin = "official" | "community";

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: "tournament", label: "Tournament" },
  { id: "cgn", label: "Community Game Night" },
  { id: "meetup", label: "Meetup" },
  { id: "patch", label: "Patch" },
  { id: "ladderPool", label: "Ladder pool" },
  { id: "other", label: "Other" },
];

export const categoryLabel = (id: Category) => CATEGORIES.find((c) => c.id === id)?.label ?? "Other";

export interface EventLink {
  label: string;
  url: string;
}

type Recurrence = { type: "weekly"; interval: number } | { type: "monthly" };

interface CatalogueEvent {
  id: string;
  title: string;
  summary: string;
  category: Category;
  origin: Origin;
  host: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  links: EventLink[];
  recurrence: Recurrence | null;
  recursUntil: number;
}

export type EntrySource = { kind: "catalogue" } | { kind: "tourney"; id: string } | { kind: "patch"; id: string };

export interface Entry {
  /** Stable per occurrence: `catalogue:<id>@<start>`, `tourney:<id>`, `patch:<id>`. */
  id: string;
  title: string;
  summary: string;
  category: Category;
  origin: Origin;
  host: string;
  startsAt: number;
  /** 0 when nothing said. */
  endsAt: number;
  allDay: boolean;
  links: EventLink[];
  source: EntrySource;
}

export const DEFAULT_SUBMIT_URL = "https://github.com/FAForeverRustClient/events/issues/new/choose";

// ---- reading the sources (crates/faf-app/src/infra/events.rs)

type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A bare `YYYY-MM-DD` (all day) or a full ISO timestamp, in Unix seconds. */
function moment(raw: unknown): { at: number; isDay: boolean } | null {
  const value = str(raw);
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const at = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(at) ? null : { at: at / 1000, isDay: true };
  }
  // RFC 3339 only: a timestamp without a zone would be read in the reader's.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : { at: Math.floor(at / 1000), isDay: false };
}

function category(raw: unknown): Category {
  const value = str(raw).toLowerCase();
  if (value === "ladderpool" || value === "ladder_pool" || value === "ladder-pool") return "ladderPool";
  return (["patch", "tournament", "meetup", "cgn"] as const).find((c) => c === value) ?? "other";
}

/** Every link becomes a button, so only plain https addresses are kept. */
function safeUrl(raw: unknown): string | null {
  const url = str(raw);
  return url.startsWith("https://") && url.length >= 12 && !/\s/.test(url) ? url : null;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function recurrence(raw: unknown): Recurrence | null {
  if (raw === "monthly") return { type: "monthly" };
  if (raw && typeof raw === "object" && "weekly" in raw) {
    const weekly = (raw as { weekly?: { interval?: unknown } }).weekly;
    const interval = Number(weekly?.interval);
    return { type: "weekly", interval: Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : 1 };
  }
  return null;
}

/** The catalogue document: entries without a title or a readable date are dropped. */
export function parseCatalogue(doc: unknown): { events: CatalogueEvent[]; submitUrl: string } {
  const root = (doc && typeof doc === "object" ? doc : {}) as Json;
  const list = Array.isArray(root.events) ? root.events : Array.isArray(doc) ? (doc as unknown[]) : [];
  const events: CatalogueEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const e = item as Json;
    const title = str(e.title);
    const start = moment(e.startsAt);
    if (!title || !start) continue;
    const end = moment(e.endsAt);
    const until = moment(e.recursUntil);
    const links: EventLink[] = [];
    for (const link of Array.isArray(e.links) ? e.links : []) {
      const url = safeUrl((link as Json)?.url);
      if (url) links.push({ label: str((link as Json).label) || "Open", url });
    }
    events.push({
      id: str(e.id) || `${slug(title)}-${start.at}`,
      title,
      summary: str(e.summary),
      category: category(e.category),
      origin: str(e.origin).toLowerCase() === "official" ? "official" : "community",
      host: str(e.host),
      startsAt: start.at,
      endsAt: end ? end.at : 0,
      allDay: typeof e.allDay === "boolean" ? e.allDay : start.isDay,
      links,
      recurrence: recurrence(e.recurrence),
      recursUntil: until ? until.at : 0,
    });
  }
  return { events, submitUrl: safeUrl(root.submitUrl) ?? DEFAULT_SUBMIT_URL };
}

// ---- repeats

const WEEK = 7 * 24 * 60 * 60;
/** A guard against a broken rule, not a policy: a year of weekly is 53. */
const MAX_OCCURRENCES = 80;

/** Shift by whole months in UTC, clamped to the month's end (the 31st is the 30th in April). */
function addUtcMonths(seconds: number, months: number): number {
  const d = new Date(seconds * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

function occurrenceAt(start: number, rule: Recurrence, index: number): number {
  return rule.type === "weekly" ? start + index * rule.interval * WEEK : addUtcMonths(start, index);
}

/** Every start of one entry inside `[from, to)`. Each is counted from the first, so the monthly clamp does not stick. */
export function occurrences(event: CatalogueEvent, from: number, to: number): number[] {
  const rule = event.recurrence;
  if (!rule) return event.startsAt >= from && event.startsAt < to ? [event.startsAt] : [];
  const limit = event.recursUntil > 0 ? Math.min(to, event.recursUntil + 1) : to;
  let first = 0;
  if (from > event.startsAt) {
    if (rule.type === "weekly") first = Math.floor((from - event.startsAt) / (rule.interval * WEEK));
    else {
      const s = new Date(event.startsAt * 1000);
      const f = new Date(from * 1000);
      first = Math.max(0, (f.getUTCFullYear() - s.getUTCFullYear()) * 12 + f.getUTCMonth() - s.getUTCMonth() - 1);
    }
  }
  const found: number[] = [];
  for (let index = first; index < first + MAX_OCCURRENCES; index++) {
    const at = occurrenceAt(event.startsAt, rule, index);
    if (at >= limit) break;
    if (at >= from) found.push(at);
  }
  return found;
}

// ---- the feed

export interface Tournament {
  id: string;
  name: string;
  eventDate: number;
  origin: Origin;
  series: string;
}

/** The tournament site's list (an array, or { tournaments }), as the calendar needs it. */
export function parseTournaments(doc: unknown): Tournament[] {
  const list = Array.isArray(doc) ? doc : Array.isArray((doc as Json)?.tournaments) ? ((doc as Json).tournaments as unknown[]) : [];
  const out: Tournament[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const t = item as Json;
    // Missing or null means published; drafts and abandoned ones stay off.
    if (t.published === false || t.abandoned === true || str(t.status) === "draft") continue;
    const date = moment(t.eventDate);
    const id = t.id == null ? "" : String(t.id);
    if (!date || !id) continue;
    out.push({
      id,
      name: str(t.name) || "Tournament",
      eventDate: date.at,
      origin: str(t.category).toLowerCase() === "official" ? "official" : "community",
      series: str(t.seriesName),
    });
  }
  return out;
}

export function buildFeed(input: {
  catalogue: CatalogueEvent[];
  tournaments: Tournament[];
  releases: Release[];
  tournamentUrl: (id: string) => string;
  from: number;
  to: number;
}): Entry[] {
  const { catalogue, tournaments, releases, from, to } = input;
  const entries: Entry[] = [];
  for (const event of catalogue) {
    for (const startsAt of occurrences(event, from, to)) {
      entries.push({
        id: `catalogue:${event.id}@${startsAt}`,
        title: event.title,
        summary: event.summary,
        category: event.category,
        origin: event.origin,
        host: event.host,
        startsAt,
        // A repeat keeps the first one's length, not its end date.
        endsAt: event.endsAt > event.startsAt ? startsAt + (event.endsAt - event.startsAt) : 0,
        allDay: event.allDay,
        links: event.links,
        source: { kind: "catalogue" },
      });
    }
  }
  for (const t of tournaments) {
    if (t.eventDate < from || t.eventDate >= to) continue;
    entries.push({
      id: `tourney:${t.id}`,
      title: t.name,
      summary: "",
      category: "tournament",
      origin: t.origin,
      host: t.series,
      startsAt: t.eventDate,
      endsAt: 0,
      allDay: false,
      links: [{ label: "Open tournament", url: input.tournamentUrl(t.id) }],
      source: { kind: "tourney", id: t.id },
    });
  }
  for (const r of releases) {
    const startsAt = Date.parse(`${r.date}T00:00:00Z`) / 1000;
    if (Number.isNaN(startsAt) || startsAt < from || startsAt >= to) continue;
    entries.push({
      id: `patch:${r.id}`,
      title: `${r.kind} ${r.id}`,
      summary: "",
      category: "patch",
      origin: "official",
      host: "FAForever",
      startsAt,
      endsAt: 0,
      allDay: true,
      links: [],
      source: { kind: "patch", id: r.id },
    });
  }
  return entries.sort((a, b) => (a.startsAt === b.startsAt ? a.title.localeCompare(b.title) : a.startsAt - b.startsAt));
}

/** Over at its end, an hour after a start without one, or at the end of an all-day entry's day. */
export function hasPassed(entry: Entry, now: number): boolean {
  if (entry.allDay) return now >= entry.startsAt + 86_400;
  return now >= (entry.endsAt > entry.startsAt ? entry.endsAt : entry.startsAt + 3_600);
}

// ---- days, in the reader's zone

export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The day an entry belongs on: the reader's for a timed one, UTC's for an all-day one. */
export function dayOf(entry: Entry): string {
  return entry.allDay ? new Date(entry.startsAt * 1000).toISOString().slice(0, 10) : isoDay(new Date(entry.startsAt * 1000));
}

export function parseIsoDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Six whole weeks, Monday first, around the month of `date`: the grid never changes height. */
export function monthGrid(date: Date): Date[] {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function byDay(entries: Entry[]): Map<string, Entry[]> {
  const days = new Map<string, Entry[]>();
  for (const entry of entries) {
    const day = dayOf(entry);
    const list = days.get(day);
    if (list) list.push(entry);
    else days.set(day, [entry]);
  }
  return days;
}

// ---- words

const time = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "19:00 - 23:00", "19:00", or "" for all day. */
export function entryTime(entry: Entry): string {
  if (entry.allDay) return "";
  return entry.endsAt > entry.startsAt ? `${time(entry.startsAt)} - ${time(entry.endsAt)}` : time(entry.startsAt);
}

export function entryStart(entry: Entry): string {
  return entry.allDay ? "" : time(entry.startsAt);
}

/** "Today" / "Tomorrow", or "" for any other day. */
export function relativeDay(date: Date, now: Date): string {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(now)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : "";
}

export function localZoneName(): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// ---- add to a calendar app

function icsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

const icsStamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10).replace(/-/g, "");

/** One entry as an iCalendar file, so a phone or desktop calendar can remind about it. */
export function toIcs(entry: Entry, pageUrl: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FAForever//webclient//EN",
    "BEGIN:VEVENT",
    `UID:${entry.id.replace(/[^A-Za-z0-9@:._-]/g, "-")}@webclient.faforever.com`,
    `DTSTAMP:${icsStamp(Date.now() / 1000)}`,
  ];
  if (entry.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(entry.startsAt)}`, `DTEND;VALUE=DATE:${icsDate(entry.startsAt + 86_400)}`);
  } else {
    lines.push(`DTSTART:${icsStamp(entry.startsAt)}`, `DTEND:${icsStamp(entry.endsAt > entry.startsAt ? entry.endsAt : entry.startsAt + 3600)}`);
  }
  const description = [entry.summary, ...entry.links.map((l) => `${l.label}: ${l.url}`)].filter(Boolean).join("\n");
  lines.push(`SUMMARY:${icsText(entry.title)}`);
  if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
  lines.push(`URL:${entry.links[0]?.url ?? pageUrl}`, "END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Lines over 75 characters continue on the next, after a space (RFC 5545 3.1). */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let at = 75; at < line.length; at += 74) parts.push(line.slice(at, at + 74));
  return parts.join("\r\n ");
}
