import { useEffect, useState } from "react";
import { fafPath, mapPreviewUrl, pick, related, type JsonApiDocument, type JsonApiResource } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

const PAGE_SIZE = 20;

// gamePlayerStats.faction, as the Rust client maps it (faf-domain protocol/replay_query.rs).
const FACTIONS: Record<string, string> = { "1": "UEF", "2": "Aeon", "3": "Cybran", "4": "Seraphim", "5": "Nomad" };

function factionName(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value);
  if (FACTIONS[text]) return FACTIONS[text];
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function duration(start: unknown, end: unknown): string | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function whenPlayed(value: unknown): string {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Displayed rating before the game: mean - 3 * deviation, as FAF shows it. */
function shownRating(stats: Record<string, unknown>): number | null {
  const mean = pick<number>(stats, "beforeMean");
  const deviation = pick<number>(stats, "beforeDeviation");
  if (typeof mean !== "number" || typeof deviation !== "number") return null;
  return Math.round(mean - 3 * deviation);
}

function teamsOf(doc: JsonApiDocument, game: JsonApiResource) {
  const refs = game.relationships?.playerStats?.data;
  const stats = (Array.isArray(refs) ? refs : [])
    .map((ref) => doc.included?.find((item) => item.type === ref.type && item.id === ref.id))
    .filter((item): item is JsonApiResource => Boolean(item));

  const teams = new Map<number, { name: string; faction: string | null; rating: number | null }[]>();
  for (const stat of stats) {
    const a = stat.attributes ?? {};
    const player = related(doc, stat, "player");
    const team = Number(pick(a, "team") ?? 1);
    const list = teams.get(team) ?? [];
    list.push({
      name: pick<string>(player?.attributes, "login") ?? "unknown",
      faction: factionName(pick(a, "faction")),
      rating: shownRating(a),
    });
    teams.set(team, list);
  }
  return [...teams.entries()].sort(([a], [b]) => a - b);
}

function ReplayCard({ doc, game }: { doc: JsonApiDocument; game: JsonApiResource }) {
  const a = game.attributes ?? {};
  const mapVersion = related(doc, game, "mapVersion");
  const map = mapVersion ? related(doc, mapVersion, "map") : undefined;
  const mod = related(doc, game, "featuredMod");
  const folder = pick<string>(mapVersion?.attributes, "folderName");
  const length = duration(pick(a, "startTime"), pick(a, "endTime"));
  const available = pick<boolean>(a, "replayAvailable") !== false;
  const modName = pick<string>(mod?.attributes, "technicalName");

  return (
    <article className="web-card web-lobby">
      {folder ? (
        <img
          className="web-lobby-preview"
          src={mapPreviewUrl(folder)}
          alt=""
          loading="lazy"
          onError={(event) => event.currentTarget.classList.add("is-missing")}
        />
      ) : (
        <div className="web-lobby-preview is-missing" />
      )}
      <div className="web-lobby-body">
        <h2 className="web-card-title">{pick<string>(a, "name") ?? `Game ${game.id}`}</h2>
        <p className="muted web-lobby-map">{pick<string>(map?.attributes, "displayName") ?? folder ?? "-"}</p>
        <div className="web-chips">
          <span className="web-chip">{whenPlayed(pick(a, "endTime", "startTime"))}</span>
          {length && <span className="web-chip">{length}</span>}
          {modName && modName !== "faf" && <span className="web-chip">{modName}</span>}
          {pick<string>(a, "validity") && pick<string>(a, "validity") !== "VALID" && <span className="web-chip">Unranked</span>}
        </div>
        <ul className="web-teams">
          {teamsOf(doc, game).map(([team, players]) => (
            <li key={team}>
              <span className="web-team-label">{team <= 1 ? "No team" : `Team ${team - 1}`}</span>
              {players
                .map((p) => {
                  const extra = [p.faction, p.rating != null ? String(p.rating) : null].filter(Boolean).join(", ");
                  return extra ? `${p.name} (${extra})` : p.name;
                })
                .join(" · ")}
            </li>
          ))}
        </ul>
        <div className="web-card-actions">
          <span className="muted">#{game.id}</span>
          {available ? (
            <a className="web-button" href={`https://replay.faforever.com/${encodeURIComponent(game.id)}`} rel="noopener noreferrer">
              Download replay
            </a>
          ) : (
            <span className="muted">No replay file</span>
          )}
        </div>
      </div>
    </article>
  );
}

export function ReplaysView() {
  const [typed, setTyped] = useState("");
  const [player, setPlayer] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPlayer(typed.trim());
      setPage(1);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [typed]);

  // Same include list as the Rust client's replay vault (infra/replay/vault.rs), minus avatars and reviews.
  const filters = ["endTime=isnull=false"];
  if (player) filters.push(`playerStats.player.login=="${player.replace(/["\\]/g, "")}"`);
  const load = useJson<JsonApiDocument>(
    fafPath("game", {
      include: "mapVersion,mapVersion.map,featuredMod,playerStats,playerStats.player",
      sort: "-endTime",
      filter: filters.join(";"),
      "page[size]": String(PAGE_SIZE),
      "page[number]": String(page),
    }),
  );
  const games = load.state === "ready" ? load.data.data ?? [] : [];

  return (
    <div className="web-view">
      <ViewHeader title="Replays" description="Recently finished games. Download a replay to watch it in the desktop client." />
      <label className="web-search">
        <Icon name="search" size={16} />
        <input type="search" placeholder="Player name (exact)" value={typed} onChange={(event) => setTyped(event.target.value)} />
      </label>

      {load.state === "loading" && <Loading what="replays" />}
      {load.state === "error" && <LoadFailed icon="replays" what="replays" status={load.status} code={load.code} />}
      {load.state === "ready" &&
        (games.length === 0 ? (
          <EmptyState icon="replays" title="No replays found" hint={player ? `No finished games for "${player}".` : undefined} bordered />
        ) : (
          <>
            <div className="web-grid">
              {games.map((game) => (
                <ReplayCard key={game.id} doc={load.data} game={game} />
              ))}
            </div>
            <div className="web-pager">
              <button className="web-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted">Page {page}</span>
              <button className="web-button" disabled={games.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </>
        ))}
    </div>
  );
}
