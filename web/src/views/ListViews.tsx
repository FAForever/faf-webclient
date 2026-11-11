import { formatDate, pick } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon, type IconName } from "../ds/Icon";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

type Row = Record<string, unknown>;

// Status values of the tournament site (Rust client faf-domain state/tourney/tournament.rs).
const TOURNEY_STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "" },
  signup: { label: "Sign-up open", tone: "is-open" },
  drafted: { label: "Teams drafted", tone: "is-open" },
  running: { label: "Running", tone: "is-full" },
  finished: { label: "Finished", tone: "" },
};

function teamSize(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${n}v${n}` : null;
}

/** The tournament site sends the headline prize as { currency, amount } (faf-tournaments server.js). */
function prizeText(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (!value || typeof value !== "object") return null;
  const { amount, currency } = value as { amount?: unknown; currency?: unknown };
  if (amount == null || amount === "") return null;
  return [String(amount), typeof currency === "string" ? currency : null].filter(Boolean).join(" ");
}

/** "8 teams" for team tournaments, "12 players" for 1v1 and FFA. */
function entrants(t: Row): string | null {
  const size = Number(pick(t, "teamSize"));
  const teams = Number(pick(t, "teams"));
  const players = Number(pick(t, "players"));
  if (size > 1 && teams > 0) return `${teams} ${teams === 1 ? "team" : "teams"}`;
  if (players > 0) return `${players} ${players === 1 ? "player" : "players"}`;
  return null;
}

function ratingLimit(t: Row): string | null {
  const min = pick<number>(t, "minRating");
  const max = pick<number>(t, "maxRating");
  if (min != null && max != null) return `${min} to ${max}`;
  if (min != null) return `${min}+`;
  if (max != null) return `up to ${max}`;
  return null;
}

export function TournamentsView() {
  // The tournament site answers with a bare array (or { tournaments }).
  const load = useJson<Row[] | { tournaments?: Row[] }>("/api/tourney/tournaments", 60000);
  const items = load.state === "ready" ? (Array.isArray(load.data) ? load.data : load.data.tournaments ?? []) : [];
  // Running first, finished last; anything unrecognised after finished.
  const order = ["running", "signup", "drafted", "draft", "finished"];
  const rank = (t: Row) => {
    const index = order.indexOf(String(pick(t, "status")));
    return index === -1 ? order.length : index;
  };
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));

  return (
    <div className="web-view">
      <ViewHeader title="Tournaments" description="From tournaments.faforever.com." />
      {load.state === "loading" && <Loading what="tournaments" />}
      {load.state === "error" && <LoadFailed icon="trophy" what="tournaments" status={load.status} code={load.code} />}
      {load.state === "ready" &&
        (sorted.length === 0 ? (
          <EmptyState icon="trophy" title="No tournaments" bordered />
        ) : (
          <div className="web-list">
            {sorted.map((t, i) => {
              const id = pick<string | number>(t, "id");
              const status = pick(t, "abandoned")
                ? { label: "Abandoned", tone: "" }
                : TOURNEY_STATUS[String(pick(t, "status"))] ?? { label: String(pick(t, "status") ?? "Unknown"), tone: "" };
              const prize = prizeText(pick(t, "prize"));
              const details = [
                teamSize(pick(t, "teamSize")),
                entrants(t),
                ratingLimit(t),
                pick(t, "eventDate") ? formatDate(pick(t, "eventDate")) : null,
              ].filter(Boolean);
              return (
                <article key={String(id ?? i)} className="web-card web-row">
                  <div>
                    <h2 className="web-card-title">{pick<string>(t, "name") ?? "-"}</h2>
                    {details.length > 0 && <p className="muted">{details.join(" · ")}</p>}
                    {prize && <p className="muted">Prize: {prize}</p>}
                  </div>
                  <div className="web-row-end">
                    <span className={`web-chip ${status.tone}`}>{status.label}</span>
                    {id != null && (
                      <a
                        className="web-button"
                        href={`https://tournaments.faforever.com/t/${encodeURIComponent(String(id))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open <Icon name="external" size={13} />
                      </a>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ))}
    </div>
  );
}

export function EventsView() {
  const load = useJson<Row[] | { events?: Row[]; entries?: Row[] }>("/api/events/calendar.json", 300000);
  const items = load.state === "ready" ? (Array.isArray(load.data) ? load.data : load.data.events ?? load.data.entries ?? []) : [];
  return (
    <div className="web-view">
      <ViewHeader title="Events" description="Community events calendar." />
      {load.state === "loading" && <Loading what="events" />}
      {load.state === "error" && <LoadFailed icon="calendar" what="events" status={load.status} code={load.code} />}
      {load.state === "ready" &&
        (items.length === 0 ? (
          <EmptyState icon="calendar" title="No upcoming events" bordered />
        ) : (
          <div className="web-list">
            {items.map((ev, i) => {
              const url = pick<string>(ev, "url", "link");
              return (
                <article key={i} className="web-card web-row">
                  <div>
                    <h2 className="web-card-title">{pick<string>(ev, "title", "name") ?? "-"}</h2>
                    {pick<string>(ev, "description", "summary") && <p className="muted">{pick<string>(ev, "description", "summary")}</p>}
                    {url && (
                      <a href={url} target="_blank" rel="noopener noreferrer">
                        More info <Icon name="external" size={13} />
                      </a>
                    )}
                  </div>
                  <span className="web-chip">{formatDate(pick(ev, "startsAt", "starts_at", "start", "date"))}</span>
                </article>
              );
            })}
          </div>
        ))}
    </div>
  );
}

/** A page FAF already publishes, shown in place with a way out if framing is refused. */
export function EmbedView({ title, description, url }: { title: string; description: string; url: string }) {
  return (
    <div className="web-view web-view-embed">
      <ViewHeader
        title={title}
        description={description}
        actions={
          <a className="web-button" href={url} target="_blank" rel="noopener noreferrer">
            Open <Icon name="external" size={14} />
          </a>
        }
      />
      <iframe className="web-embed" src={url} title={title} loading="lazy" referrerPolicy="no-referrer" />
    </div>
  );
}

const LINKS: { title: string; url: string; icon: IconName; text: string }[] = [
  { title: "FAForever", url: "https://www.faforever.com/", icon: "home", text: "Download the client and get started." },
  { title: "Forum", url: "https://forum.faforever.com/", icon: "chat", text: "Discussion, guides and announcements." },
  { title: "Wiki", url: "https://wiki.faforever.com/", icon: "book", text: "Guides and documentation." },
  { title: "GitHub", url: "https://github.com/FAForever", icon: "github", text: "FAF's source code." },
  { title: "Rust client", url: "https://github.com/FAForeverRustClient/FAForeverRustClient", icon: "github", text: "The desktop client this site's design comes from." },
];

export function LinksView() {
  return (
    <div className="web-view">
      <ViewHeader title="Links" description="Everything else FAF." />
      <div className="web-list">
        {LINKS.map((link) => (
          <a key={link.url} className="web-card web-row web-link-card" href={link.url} target="_blank" rel="noopener noreferrer">
            <Icon name={link.icon} size={20} />
            <div>
              <h2 className="web-card-title">{link.title}</h2>
              <p className="muted">{link.text}</p>
            </div>
            <Icon name="external" size={14} />
          </a>
        ))}
      </div>
    </div>
  );
}

