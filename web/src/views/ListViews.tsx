import { formatDate, pick } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon, type IconName } from "../ds/Icon";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

type Row = Record<string, unknown>;

export function TournamentsView() {
  // The tournament site answers with a bare array.
  const load = useJson<Row[]>("/api/tourney/tournaments", 60000);
  return (
    <div className="web-view">
      <ViewHeader title="Tournaments" description="Tournaments from the FAF tournament site." />
      {load.state === "loading" && <Loading what="tournaments" />}
      {load.state === "error" && <LoadFailed icon="trophy" what="tournaments" status={load.status} />}
      {load.state === "ready" &&
        (load.data.length === 0 ? (
          <EmptyState icon="trophy" title="No tournaments" bordered />
        ) : (
          <div className="web-list">
            {load.data.map((t, i) => (
              <article key={String(pick(t, "id", "slug") ?? i)} className="web-card web-row">
                <div>
                  <h2 className="web-card-title">{pick<string>(t, "name", "title") ?? "-"}</h2>
                  <p className="muted">
                    {[pick<string>(t, "format", "type"), pick(t, "eventDate", "startDate") ? formatDate(pick(t, "eventDate", "startDate")) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <span className="web-chip">{pick<string>(t, "status") ?? "unknown"}</span>
              </article>
            ))}
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
      {load.state === "error" && <LoadFailed icon="calendar" what="events" status={load.status} />}
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

