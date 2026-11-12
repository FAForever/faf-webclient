// The Events tab, after the Rust client's (ui/src/features/events): an
// upcoming agenda and a month grid over one feed, a filter row, and the open
// entry in a panel beside them (a sheet from the bottom on a phone).
//
// The desktop client's reminders need its notification service; here an
// entry can be added to the visitor's own calendar app instead, which reminds
// them on any device.

import { useEffect, useMemo, useState } from "react";
import { parseIndex, type Release } from "../changelog/parse";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { fafUrl } from "../hosts";
import { go } from "../nav";
import { useJson, useMedia, useText, ViewHeader } from "../views/common";
import {
  addDays,
  buildFeed,
  byDay,
  CATEGORIES,
  categoryLabel,
  dayOf,
  DEFAULT_SUBMIT_URL,
  entryStart,
  entryTime,
  hasPassed,
  isoDay,
  localZoneName,
  monthGrid,
  parseCatalogue,
  parseIsoDay,
  parseTournaments,
  relativeDay,
  toIcs,
  type Category,
  type Entry,
  type Origin,
} from "./calendar";
import "./events.css";

type View = "upcoming" | "month";

interface Query {
  text: string;
  category: Category | "";
  origin: Origin | "";
}

const NO_QUERY: Query = { text: "", category: "", origin: "" };

/** The clock, a minute at a time: what is "past" and "today" moves on while the tab is open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const today = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

function matches(entry: Entry, query: Query): boolean {
  if (query.category && entry.category !== query.category) return false;
  if (query.origin && entry.origin !== query.origin) return false;
  const text = query.text.trim().toLowerCase();
  return !text || [entry.title, entry.host, entry.summary].some((v) => v.toLowerCase().includes(text));
}

function downloadIcs(entry: Entry) {
  const blob = new Blob([toIcs(entry, `${window.location.origin}/events`)], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${entry.title.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "event"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- the agenda

function AgendaRow({ entry, past, selected, onOpen }: { entry: Entry; past: boolean; selected: boolean; onOpen: (e: Entry) => void }) {
  const meta = [categoryLabel(entry.category), entry.host].filter(Boolean).join(" · ");
  const classes = ["event-agenda-row", `is-${entry.category}`, past ? "is-past" : "", selected ? "is-selected" : ""].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} aria-pressed={selected} onClick={() => onOpen(entry)}>
      <span className="event-agenda-time">{entryTime(entry) || "All day"}</span>
      <span className="event-agenda-title">
        <span className="event-dot" aria-hidden="true" />
        <span className="event-agenda-name">{entry.title}</span>
      </span>
      <span className="event-agenda-meta">{meta}</span>
    </button>
  );
}

function Agenda({ entries, now, selected, onOpen }: { entries: Entry[]; now: Date; selected: string | null; onOpen: (e: Entry) => void }) {
  const groups = byDay(entries);
  const nowSeconds = seconds(now);
  return (
    <div className="event-agenda">
      {[...groups.entries()].map(([day, group]) => {
        const date = parseIsoDay(day);
        const relative = date ? relativeDay(date, now) : "";
        const isToday = date !== null && isoDay(date) === isoDay(now);
        return (
          <section className={isToday ? "event-agenda-day is-today" : "event-agenda-day"} key={day}>
            <h3
              className="event-agenda-date"
              aria-label={date ? date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : day}
            >
              {date ? (
                <>
                  <span className="event-agenda-daynum">{date.getDate()}</span>
                  <span className="event-agenda-daywords" aria-hidden="true">
                    <span className={relative ? "event-agenda-relative" : undefined}>
                      {relative || date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span>{date.toLocaleDateString(undefined, { month: "short" })}</span>
                  </span>
                </>
              ) : (
                day
              )}
            </h3>
            <div className="event-agenda-entries">
              {group.map((entry) => (
                <AgendaRow key={entry.id} entry={entry} past={hasPassed(entry, nowSeconds)} selected={entry.id === selected} onOpen={onOpen} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---- the month

/** Two chips fit a square; the rest is counted. */
const CHIPS_PER_DAY = 2;

function EventChip({ entry, selected, onOpen }: { entry: Entry; selected: boolean; onOpen: (e: Entry) => void }) {
  const time = entryStart(entry);
  const classes = ["event-chip", `is-${entry.category}`, time ? "" : "is-untimed", selected ? "is-selected" : ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={classes}
      onClick={() => onOpen(entry)}
      aria-pressed={selected}
      title={[categoryLabel(entry.category), entryTime(entry), entry.title].filter(Boolean).join(" · ")}
    >
      <span className="event-chip-mark" aria-hidden="true">
        <span className="event-dot" />
      </span>
      {time && <span className="event-chip-time">{time}</span>}
      <span className="event-chip-title">{entry.title}</span>
    </button>
  );
}

function Month({
  anchor,
  now,
  days,
  narrow,
  pickedDay,
  selected,
  onOpen,
  onPickDay,
}: {
  anchor: Date;
  now: Date;
  days: Map<string, Entry[]>;
  narrow: boolean;
  pickedDay: string | null;
  selected: string | null;
  onOpen: (e: Entry) => void;
  onPickDay: (day: string) => void;
}) {
  const squares = monthGrid(anchor);
  const names = squares.slice(0, 7).map((d) => d.toLocaleDateString(undefined, { weekday: narrow ? "narrow" : "short" }));
  const todayKey = isoDay(now);
  return (
    <div className={narrow ? "event-month is-compact" : "event-month"}>
      <div className="event-month-head" aria-hidden="true">
        {names.map((name, i) => (
          <span key={i}>{name}</span>
        ))}
      </div>
      <div className="event-month-grid">
        {squares.map((day) => {
          const key = isoDay(day);
          const entries = days.get(key) ?? [];
          const classes = [
            "event-day",
            day.getMonth() !== anchor.getMonth() ? "is-outside" : "",
            key === todayKey ? "is-today" : "",
            key === pickedDay ? "is-picked" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const label = `${day.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}${
            entries.length ? `, ${entries.length} ${entries.length === 1 ? "event" : "events"}` : ""
          }`;
          // A phone square is about 50 px wide: a dot per entry, and the day's
          // list under the grid when it is tapped.
          if (narrow) {
            return (
              <button type="button" key={key} className={classes} onClick={() => onPickDay(key)} aria-label={label} aria-pressed={key === pickedDay}>
                <span className="event-day-number">{day.getDate()}</span>
                <span className="event-day-dots" aria-hidden="true">
                  {entries.slice(0, 4).map((entry) => (
                    <span key={entry.id} className={`event-dot event-mark is-${entry.category}`} />
                  ))}
                </span>
              </button>
            );
          }
          const hidden = entries.length - CHIPS_PER_DAY;
          return (
            <div className={classes} key={key}>
              <button type="button" className="event-day-number" onClick={() => onPickDay(key)} aria-label={label} aria-current={key === todayKey ? "date" : undefined}>
                {day.getDate()}
              </button>
              <div className="event-day-entries">
                {entries.slice(0, CHIPS_PER_DAY).map((entry) => (
                  <EventChip key={entry.id} entry={entry} selected={entry.id === selected} onOpen={onOpen} />
                ))}
                {hidden > 0 && (
                  <button type="button" className="event-day-more" onClick={() => onPickDay(key)}>
                    +{hidden} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- the open entry

function Detail({ entry, now, onClose }: { entry: Entry | null; now: Date; onClose?: () => void }) {
  if (!entry) {
    return (
      <aside className="event-panel surface-panel is-empty" aria-label="Event details">
        <EmptyState icon="calendar" title="No event selected" hint="Select an event to see when it is and who runs it." />
      </aside>
    );
  }
  const time = entryTime(entry);
  const zone = localZoneName();
  const date = parseIsoDay(dayOf(entry));
  const over = hasPassed(entry, seconds(now));
  const patchId = entry.source.kind === "patch" ? entry.source.id : null;
  return (
    <aside className="event-panel surface-panel" aria-label={entry.title}>
      <header className="event-panel-head">
        <div>
          <h2>{entry.title}</h2>
          <div className="event-panel-tags">
            <span className={`event-tag is-${entry.category}`}>
              <span className="event-dot" aria-hidden="true" />
              {categoryLabel(entry.category)}
            </span>
            <span className={`event-tag is-${entry.origin}`}>
              <Icon name={entry.origin === "official" ? "shield" : "users"} size={12} />
              {entry.origin === "official" ? "Official" : "Community"}
            </span>
          </div>
        </div>
        {onClose && (
          <button type="button" className="web-icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        )}
      </header>

      <ul className="event-panel-facts">
        <li>
          <Icon name="clock" size={15} />
          <span>
            {time || "All day"}
            {time && zone && <span className="event-panel-zone"> {zone}</span>}
          </span>
        </li>
        <li>
          <Icon name="calendar" size={15} />
          <span>{date ? date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : dayOf(entry)}</span>
        </li>
        {entry.host && (
          <li>
            <Icon name="user" size={15} />
            <span>
              <span className="event-panel-label">Run by</span> {entry.host}
            </span>
          </li>
        )}
      </ul>

      {entry.summary && <p className="event-panel-summary">{entry.summary}</p>}
      {over && <p className="event-panel-over">This event is over.</p>}

      <div className="event-panel-actions">
        {patchId && (
          <button type="button" className="web-button web-button-primary" onClick={() => go(`/changelog/${patchId}`)}>
            <Icon name="changelog" size={14} /> Read the patch notes
          </button>
        )}
        {entry.links.map((link, i) => (
          <a
            key={link.url}
            className={`web-button${i === 0 && !patchId ? " web-button-primary" : ""}`}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={link.url}
          >
            {link.label} <Icon name="external" size={13} />
          </a>
        ))}
        {!over && (
          <button type="button" className="web-button" onClick={() => downloadIcs(entry)}>
            <Icon name="calendar" size={14} /> Add to my calendar
          </button>
        )}
      </div>
    </aside>
  );
}

// ---- the tab

export function EventsView() {
  const catalogueLoad = useJson<unknown>("/api/events/calendar.json", 300_000);
  const tourneyLoad = useJson<unknown>("/api/tourney/tournaments", 300_000);
  const indexLoad = useText("/api/changelog/changelog");
  const now = useNow();
  const narrow = useMedia("(max-width: 900px)");

  const [view, setView] = useState<View>("upcoming");
  const [anchor, setAnchor] = useState(() => today(new Date()));
  const [query, setQuery] = useState<Query>(NO_QUERY);
  const [open, setOpen] = useState<Entry | null>(null);
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  const catalogue = useMemo(() => (catalogueLoad.state === "ready" ? parseCatalogue(catalogueLoad.data) : null), [catalogueLoad]);
  const tournaments = useMemo(() => (tourneyLoad.state === "ready" ? parseTournaments(tourneyLoad.data) : []), [tourneyLoad]);
  const releases: Release[] = useMemo(() => (indexLoad.state === "ready" ? parseIndex(indexLoad.data) : []), [indexLoad]);

  // Upcoming covers a year from the start of today, so something already
  // running stays on top; the month covers its six weeks of squares.
  const span = useMemo(() => {
    if (view === "month") {
      const squares = monthGrid(anchor);
      return { from: seconds(squares[0]), to: seconds(addDays(squares[41], 1)) };
    }
    const start = today(now);
    return { from: seconds(start), to: seconds(addDays(start, 366)) };
  }, [view, anchor, now]);

  const entries = useMemo(
    () =>
      buildFeed({
        catalogue: catalogue?.events ?? [],
        tournaments,
        releases,
        tournamentUrl: (id) => `${fafUrl("tournaments")}/t/${encodeURIComponent(id)}`,
        ...span,
      }).filter((entry) => matches(entry, query)),
    [catalogue, tournaments, releases, span, query],
  );
  const days = useMemo(() => byDay(entries), [entries]);

  const settled = catalogueLoad.state !== "loading";
  const filtered = query.text.trim() !== "" || query.category !== "" || query.origin !== "";
  const patch = (change: Partial<Query>) => setQuery((q) => ({ ...q, ...change }));

  const step = (months: number) => {
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + months, 1));
    setPickedDay(null);
  };

  // On a phone the open entry is a sheet: Escape closes it.
  useEffect(() => {
    if (!narrow || !open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow, open]);

  const dayEntries = pickedDay ? days.get(pickedDay) ?? [] : [];
  const picked = pickedDay ? parseIsoDay(pickedDay) : null;

  return (
    <div className="web-view web-view-wide">
      <ViewHeader
        title="Events"
        description="Tournaments, patches and community events, in your time zone."
        actions={
          <a className="web-button" href={catalogue?.submitUrl ?? DEFAULT_SUBMIT_URL} target="_blank" rel="noopener noreferrer">
            <Icon name="plus" size={14} /> Suggest an event
          </a>
        }
      />

      <div className="events-toolbar">
        <div className="web-segmented" role="group" aria-label="Calendar view">
          {(["upcoming", "month"] as const).map((v) => (
            <button key={v} type="button" className={view === v ? "is-active" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "upcoming" ? "Upcoming" : "Month"}
            </button>
          ))}
        </div>
        {view === "month" && (
          <div className="events-period" role="group" aria-label="Move through the calendar">
            <button
              type="button"
              className="web-button"
              onClick={() => {
                setAnchor(today(now));
                setPickedDay(null);
              }}
            >
              Today
            </button>
            <div className="events-period-steps">
              <button type="button" className="events-period-step" onClick={() => step(-1)} aria-label="Earlier" title="Earlier">
                <Icon name="arrowLeft" size={15} />
              </button>
              <button type="button" className="events-period-step" onClick={() => step(1)} aria-label="Later" title="Later">
                <Icon name="arrowRight" size={15} />
              </button>
            </div>
            <strong>{anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
          </div>
        )}
      </div>

      <div className="events-filters">
        <label className="web-search events-search">
          <Icon name="search" size={15} />
          <input type="search" value={query.text} placeholder="Search events" aria-label="Search events" onChange={(e) => patch({ text: e.target.value })} />
        </label>
        <label className="web-select">
          <span>Category</span>
          <select value={query.category} onChange={(e) => patch({ category: e.target.value as Category | "" })}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="web-select">
          <span>Run by</span>
          <select value={query.origin} onChange={(e) => patch({ origin: e.target.value as Origin | "" })}>
            <option value="">Anyone</option>
            <option value="official">FAF (official)</option>
            <option value="community">Community</option>
          </select>
        </label>
        {filtered && (
          <button type="button" className="web-button" onClick={() => setQuery(NO_QUERY)}>
            <Icon name="close" size={13} /> Clear
          </button>
        )}
      </div>

      {catalogueLoad.state === "error" && (
        <p className="events-notice" role="status">
          The community calendar couldn't be loaded right now. Tournaments and patches are still shown.
        </p>
      )}

      <div className="events-layout">
        <div className="events-main">
          {!settled && <p className="muted">Loading events...</p>}

          {settled && view === "upcoming" && entries.length === 0 && (
            <EmptyState
              bordered
              icon={filtered ? "filter" : "calendar"}
              title={filtered ? "Nothing matches those filters" : "Nothing coming up"}
              hint={filtered ? undefined : "Tournaments and patches appear here on their own. Anybody can suggest a community event."}
            />
          )}
          {settled && view === "upcoming" && entries.length > 0 && (
            <Agenda entries={entries} now={now} selected={open?.id ?? null} onOpen={setOpen} />
          )}

          {settled && view === "month" && (
            <>
              {entries.length === 0 && (
                <p className="events-notice" role="status">
                  {filtered ? "Nothing this month matches those filters." : "Nothing on this month."}
                </p>
              )}
              <Month
                anchor={anchor}
                now={now}
                days={days}
                narrow={narrow}
                pickedDay={pickedDay}
                selected={open?.id ?? null}
                onOpen={setOpen}
                onPickDay={(day) => setPickedDay((d) => (d === day ? null : day))}
              />
              {picked && (
                <section className="events-day-list" aria-label={picked.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}>
                  {dayEntries.length > 0 ? (
                    <Agenda entries={dayEntries} now={now} selected={open?.id ?? null} onOpen={setOpen} />
                  ) : (
                    <p className="events-notice">Nothing on {picked.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}.</p>
                  )}
                </section>
              )}
              {narrow && !picked && entries.length > 0 && <p className="events-notice">Tap a day to see its events.</p>}
            </>
          )}
        </div>

        {!narrow && <Detail entry={open} now={now} />}
      </div>

      {narrow && open && (
        <div className="web-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="web-dialog event-sheet" role="dialog" aria-modal="true" aria-label={open.title}>
            <Detail entry={open} now={now} onClose={() => setOpen(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
