// The replay search panel, after the Rust client's online replay vault
// (ui/src/features/replays/online/VaultSearch.tsx and AdvancedReplayFilters.tsx):
// the fields on top, the ranges under them, then the presets and switches, and
// the rarer filters behind "More filters". On a phone everything below the
// player field folds away behind one "Filters" button.
//
// Typed fields are applied with Search (or Enter); picking from a list,
// ticking a box or a preset applies at once, as in the Rust client.

import { useState, type ReactNode } from "react";
import { Icon } from "../ds/Icon";
import {
  changedCount,
  EMPTY_QUERY,
  FACTIONS,
  GAME_TYPES,
  isoDaysAgo,
  MORE_FIELDS,
  SHORT_GAME_MINUTES,
  SORTS,
  VICTORY_CONDITIONS,
  type ReplayQuery,
  type SortField,
} from "./query";

export interface Mode {
  id: string;
  label: string;
}

type Preset = "newest" | "bestReviewed" | "own";

function activePreset(q: ReplayQuery, me: string): Preset | null {
  if (me && q.exactPlayer && q.player.toLowerCase() === me.toLowerCase()) return "own";
  if (q.sortBy === "reviewsSummary.averageScore" && q.minReview !== "") return "bestReviewed";
  if (!q.player && q.sortBy === "startTime" && q.sortDescending) return "newest";
  return null;
}

/** The fields under the top row, for the count on the phone's "Filters" button. */
const PANEL_FIELDS: (keyof ReplayQuery)[] = [
  "map", "replayId", "mode", "gameType", "after", "before", "sortBy", "sortDescending",
  "minRating", "maxRating", "minDuration", "maxDuration", "minPlayers", "maxPlayers", "minSizeKm", "maxSizeKm", "minReview",
  "recentOnly", "exactPlayer", "skipShort", ...MORE_FIELDS,
];

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "replay-field is-wide" : "replay-field"}>
      <span className="replay-filter-label">{label}</span>
      {children}
    </label>
  );
}

function Range({
  label,
  unit,
  low,
  high,
  onLow,
  onHigh,
  step = 1,
}: {
  label: string;
  unit?: string;
  low: string;
  high: string;
  onLow: (v: string) => void;
  onHigh: (v: string) => void;
  step?: number;
}) {
  return (
    <div className="replay-field replay-range" role="group" aria-label={label}>
      <span className="replay-filter-label">
        {label}
        {unit && <span className="replay-range-unit"> ({unit})</span>}
      </span>
      <div className="replay-range-inputs">
        <input className="web-input" type="number" inputMode="numeric" step={step} placeholder="Min" aria-label={`${label}, at least`} value={low} onChange={(e) => onLow(e.target.value)} />
        <span className="muted" aria-hidden="true">
          to
        </span>
        <input className="web-input" type="number" inputMode="numeric" step={step} placeholder="Max" aria-label={`${label}, at most`} value={high} onChange={(e) => onHigh(e.target.value)} />
      </div>
    </div>
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="replay-check" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function ReplayFilters({
  draft,
  setDraft,
  apply,
  modes,
  me,
  canLogin,
  onLoginForMine,
}: {
  draft: ReplayQuery;
  setDraft: (q: ReplayQuery) => void;
  /** Runs the search with this query (the draft when none is given). */
  apply: (q?: ReplayQuery) => void;
  modes: Mode[];
  me: string;
  canLogin: boolean;
  onLoginForMine: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(() => changedCount(draft, MORE_FIELDS) > 0);

  const set = (patch: Partial<ReplayQuery>) => setDraft({ ...draft, ...patch });
  const setNow = (patch: Partial<ReplayQuery>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    apply(next);
  };

  const preset = activePreset(draft, me);
  const applyPreset = (which: Preset) => {
    // A preset sets what it is about and leaves a map, a mode or a range alone.
    const base: ReplayQuery = {
      ...draft,
      player: "",
      exactPlayer: true,
      sortBy: "startTime",
      sortDescending: true,
      minReview: "",
      after: "",
      recentOnly: true,
    };
    if (which === "own") {
      if (!me) {
        onLoginForMine();
        return;
      }
      setNow({ ...base, player: me });
    } else if (which === "bestReviewed") {
      // Few replays are ever reviewed: three years, not one, or the list is nearly empty.
      setNow({ ...base, sortBy: "reviewsSummary.averageScore", minReview: "4", after: isoDaysAgo(365 * 3) });
    } else {
      setNow(base);
    }
  };

  const panelCount = changedCount(draft, PANEL_FIELDS);
  const moreCount = changedCount(draft, MORE_FIELDS);

  return (
    <form
      className={`replay-search surface-panel${open ? " is-open" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="replay-search-top">
        <Field label="Player" wide>
          <input
            className="web-input"
            type="search"
            placeholder={draft.exactPlayer ? "Exact player name" : "Part of a player name"}
            autoComplete="off"
            value={draft.player}
            onChange={(e) => set({ player: e.target.value })}
          />
        </Field>
        <button type="submit" className="web-button web-button-primary replay-search-submit" aria-label="Search" title="Search">
          <Icon name="search" size={14} /> <span className="replay-search-submit-label">Search</span>
        </button>
        <button type="button" className="web-button replay-search-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="filter" size={14} /> Filters{panelCount > 0 ? ` (${panelCount})` : ""}
        </button>
      </div>

      <div className="replay-search-panel">
        <div className="replay-search-fields">
          <Field label="Map">
            <input className="web-input" type="search" placeholder="Any map" autoComplete="off" value={draft.map} onChange={(e) => set({ map: e.target.value })} />
          </Field>
          <Field label="Replay ID">
            <input className="web-input" inputMode="numeric" placeholder="ID or replay link" autoComplete="off" value={draft.replayId} onChange={(e) => set({ replayId: e.target.value })} />
          </Field>
          <Field label="Game mode">
            <select className="web-input" value={draft.mode} onChange={(e) => setNow({ mode: e.target.value })}>
              <option value="">Any mode</option>
              {modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Game type">
            <select className="web-input" value={draft.gameType} onChange={(e) => setNow({ gameType: e.target.value })}>
              <option value="">Any</option>
              {GAME_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="replay-field replay-dates" role="group" aria-label="Date played">
            <span className="replay-filter-label">Date played</span>
            <div className="replay-range-inputs">
              <input className="web-input" type="date" aria-label="Played on or after" value={draft.after} max={draft.before || undefined} onChange={(e) => setNow({ after: e.target.value })} />
              <span className="muted" aria-hidden="true">
                to
              </span>
              <input className="web-input" type="date" aria-label="Played on or before" value={draft.before} min={draft.after || undefined} onChange={(e) => setNow({ before: e.target.value })} />
            </div>
          </div>
          <div className="replay-field replay-sort" role="group" aria-label="Sort by">
            <span className="replay-filter-label">Sort by</span>
            <div className="replay-range-inputs">
              <select className="web-input" value={draft.sortBy} onChange={(e) => setNow({ sortBy: e.target.value as SortField })}>
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="web-button replay-sort-direction"
                title={draft.sortDescending ? "Highest or newest first" : "Lowest or oldest first"}
                aria-label={draft.sortDescending ? "Descending, switch to ascending" : "Ascending, switch to descending"}
                onClick={() => setNow({ sortDescending: !draft.sortDescending })}
              >
                <Icon name={draft.sortDescending ? "chevronDown" : "chevronUp"} size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="replay-search-ranges">
          <Range label="Any player's rating" low={draft.minRating} high={draft.maxRating} step={50} onLow={(v) => set({ minRating: v })} onHigh={(v) => set({ maxRating: v })} />
          <Range label="Duration" unit="min" low={draft.minDuration} high={draft.maxDuration} onLow={(v) => set({ minDuration: v })} onHigh={(v) => set({ maxDuration: v })} />
          <Range label="Players in the game" low={draft.minPlayers} high={draft.maxPlayers} onLow={(v) => set({ minPlayers: v })} onHigh={(v) => set({ maxPlayers: v })} />
          <Range label="Map size" unit="km" low={draft.minSizeKm} high={draft.maxSizeKm} onLow={(v) => set({ minSizeKm: v })} onHigh={(v) => set({ maxSizeKm: v })} />
          <Field label="Review score">
            <select className="web-input" value={draft.minReview} onChange={(e) => setNow({ minReview: e.target.value })}>
              <option value="">Any</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={String(n)}>
                  {n === 5 ? "5 stars" : `${n}+ stars`}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="replay-search-row">
          <div className="replay-presets" role="group" aria-label="Presets">
            <button type="button" className={`web-button${preset === "newest" ? " is-active" : ""}`} aria-pressed={preset === "newest"} onClick={() => applyPreset("newest")}>
              All replays
            </button>
            <button type="button" className={`web-button${preset === "bestReviewed" ? " is-active" : ""}`} aria-pressed={preset === "bestReviewed"} onClick={() => applyPreset("bestReviewed")}>
              Best reviewed
            </button>
            {(me || canLogin) && (
              <button
                type="button"
                className={`web-button${preset === "own" ? " is-active" : ""}`}
                aria-pressed={preset === "own"}
                title={me ? `Games played by ${me}` : "Log in with your FAF account to see your own games"}
                onClick={() => applyPreset("own")}
              >
                <Icon name="user" size={14} /> My replays
              </button>
            )}
          </div>
          <span className="replay-search-divider" aria-hidden="true" />
          <div className="replay-checks">
            <Check
              label="Recent only"
              hint="Only the last year, unless you set dates. Off searches all of FAF's history, which is slower."
              checked={draft.recentOnly}
              onChange={(v) => setNow({ recentOnly: v })}
            />
            <Check
              label="Exact player name"
              hint="On, a name matches only that player. Off, it matches every name containing it, so Deli also finds Delio."
              checked={draft.exactPlayer}
              onChange={(v) => setNow({ exactPlayer: v })}
            />
            <Check
              label="Skip short games"
              hint={`Leave out games that ended in under ${SHORT_GAME_MINUTES} minutes, which are mostly abandoned lobbies.`}
              checked={draft.skipShort}
              onChange={(v) => setNow({ skipShort: v })}
            />
          </div>
          <span className="spacer" />
          <button type="button" className={`web-button${more ? " is-active" : ""}`} aria-expanded={more} onClick={() => setMore((m) => !m)}>
            <Icon name="filter" size={14} /> {more ? "Fewer filters" : `More filters${moreCount ? ` (${moreCount})` : ""}`}
          </button>
          <button type="button" className="web-button" onClick={() => setNow({ ...EMPTY_QUERY })}>
            Clear
          </button>
        </div>

        {more && (
          <div className="replay-search-more">
            <Field label="Game title">
              <input className="web-input" type="search" placeholder="Any title" autoComplete="off" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Host">
              <input className="web-input" type="search" placeholder="Any host" autoComplete="off" value={draft.host} onChange={(e) => set({ host: e.target.value })} />
            </Field>
            <Field label="Map author">
              <input className="web-input" type="search" placeholder="Any author" autoComplete="off" value={draft.mapAuthor} onChange={(e) => set({ mapAuthor: e.target.value })} />
            </Field>
            <Field label="Faction">
              <select className="web-input" value={draft.faction} onChange={(e) => setNow({ faction: e.target.value })}>
                <option value="">Any faction</option>
                {FACTIONS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Victory condition">
              <select className="web-input" value={draft.victory} onChange={(e) => setNow({ victory: e.target.value })}>
                <option value="">Any</option>
                {VICTORY_CONDITIONS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
            <Range label="Map slots" low={draft.minSlots} high={draft.maxSlots} onLow={(v) => set({ minSlots: v })} onHigh={(v) => set({ maxSlots: v })} />
            <div className="replay-checks">
              <Check label="Ranked games only" hint="Only games that counted for rating." checked={draft.onlyRanked} onChange={(v) => setNow({ onlyRanked: v })} />
              <Check label="Ranked maps only" hint="Only games on maps that are ranked in the vault." checked={draft.rankedMapOnly} onChange={(v) => setNow({ rankedMapOnly: v })} />
            </div>
          </div>
        )}
      </div>
    </form>
  );
}
