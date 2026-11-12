// A finished game as a card, laid out as the Rust client's replay vault card
// (ui/src/features/replays/ReplayCard.tsx and ReplayRoster.tsx, after the
// Java client's replay_card.fxml): the map and the game's facts on the left;
// the title, the map's name and the way in on the right, and every player
// under them, team by team, with faction and rating.

import { useEffect, useState } from "react";
import { mapPreviewUrl, pick, related, type JsonApiDocument, type JsonApiResource } from "../api";
import { FACTION_NAMES, FactionIcon, factionId, hasGlyph } from "../ds/FactionIcon";
import { Icon, type IconName } from "../ds/Icon";
import { fafUrl } from "../hosts";

const GENERATED_MAP_PLACEHOLDER = "/assets/mapgen-placeholder.png";
/** The game runs at ten ticks a second. */
const TICKS_PER_SECOND = 10;
/** A team longer than this is laid out in two columns when it is the only one. */
const TEAM_SPLIT_AT = 4;

export interface ReplayPlayer {
  id: string | null;
  name: string;
  faction: number | null;
  rating: number | null;
}

interface ReplayTeam {
  team: number;
  players: ReplayPlayer[];
}

/** Displayed rating before the game: mean - 3 * deviation, as FAF shows it. */
function shownRating(stats: Record<string, unknown>): number | null {
  const mean = pick<number>(stats, "beforeMean");
  const deviation = pick<number>(stats, "beforeDeviation");
  if (typeof mean !== "number" || typeof deviation !== "number") return null;
  return Math.round(mean - 3 * deviation);
}

function teamsOf(doc: JsonApiDocument, game: JsonApiResource): ReplayTeam[] {
  const refs = game.relationships?.playerStats?.data;
  const teams = new Map<number, ReplayPlayer[]>();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const stat = doc.included?.find((item) => item.type === ref.type && item.id === ref.id);
    if (!stat) continue;
    const a = stat.attributes ?? {};
    const player = related(doc, stat, "player");
    const team = Number(pick(a, "team") ?? 1);
    const list = teams.get(team) ?? [];
    list.push({
      id: player?.id ?? null,
      name: pick<string>(player?.attributes, "login") ?? "unknown",
      faction: factionId(pick(a, "faction")),
      rating: shownRating(a),
    });
    teams.set(team, list);
  }
  return [...teams.entries()].sort(([a], [b]) => a - b).map(([team, players]) => ({ team, players }));
}

function teamName(team: number, soleTeam: boolean): string {
  if (soleTeam) return team === 1 ? "Free for all" : "Players";
  return team > 1 ? `Team ${team - 1}` : "Unassigned";
}


/** "17m 32s", or "1h 21m" from an hour on, as the Rust client writes it. */
function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

function secondsBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

const isGenerated = (folder: string | undefined) => Boolean(folder && /^neroxis_map_generator/i.test(folder));

function MapThumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) {
    return (
      <span className="replay-card-thumb replay-card-thumb-empty" aria-hidden="true">
        <Icon name="maps" size={32} />
      </span>
    );
  }
  return <img className="replay-card-thumb" src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function Fact({ icon, label, value, detail }: { icon: IconName; label: string; value: string; detail?: string }) {
  return (
    <span className="replay-meta-fact" title={detail ? `${label}: ${detail}` : label}>
      <Icon name={icon} size={13} />
      <span>{value || "-"}</span>
    </span>
  );
}

/** The faction's glyph, or its width in empty space, so every name starts in one column. */
function Faction({ faction }: { faction: number | null }) {
  return faction !== null && hasGlyph(faction) ? (
    <FactionIcon faction={faction} size={16} />
  ) : (
    <span className="replay-player-faction-empty" title={faction !== null ? FACTION_NAMES[faction] : undefined} />
  );
}

function Roster({ teams, me, onPlayer }: { teams: ReplayTeam[]; me: string; onPlayer: (player: ReplayPlayer) => void }) {
  if (teams.length === 0) return null;
  const soleTeam = teams.length === 1;
  return (
    <div className="replay-card-teams" data-sole-team={soleTeam ? "true" : undefined}>
      {teams.map((team) => {
        const split = soleTeam && team.players.length > TEAM_SPLIT_AT;
        return (
          <section key={team.team} className="replay-card-team">
            {/* One side only (a free-for-all, a test game): the lineup is
                the game, so it has no heading, as in the Rust client. */}
            {!soleTeam && (
              <header className="replay-card-team-title">
                <span>{teamName(team.team, soleTeam)}</span>
                <span>
                  {team.players.length} {team.players.length === 1 ? "player" : "players"}
                </span>
              </header>
            )}
            <div
              className={split ? "replay-card-team-roster is-split" : "replay-card-team-roster"}
              style={split ? { gridTemplateRows: `repeat(${Math.ceil(team.players.length / 2)}, auto)` } : undefined}
            >
              {team.players.map((player, i) => {
                const self = Boolean(me) && player.name.toLowerCase() === me.toLowerCase();
                return (
                  <div key={`${player.name}-${i}`} className={self ? "replay-player is-self" : "replay-player"}>
                    {player.id ? (
                      <button type="button" className="replay-player-identity replay-player-link" title={`Open ${player.name}'s player card`} onClick={() => onPlayer(player)}>
                        <Faction faction={player.faction} />
                        <span className="replay-player-name-text">{player.name}</span>
                      </button>
                    ) : (
                      <span className="replay-player-identity">
                        <Faction faction={player.faction} />
                        <span className="replay-player-name-text">{player.name}</span>
                      </span>
                    )}
                    {player.rating !== null && <span className="replay-card-player-stats muted">{player.rating}</span>}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function ReplayCard({
  doc,
  game,
  me,
  onPlayer,
}: {
  doc: JsonApiDocument;
  game: JsonApiResource;
  /** The logged-in player's name, drawn in their own colour in the lineup. */
  me: string;
  onPlayer: (player: ReplayPlayer) => void;
}) {
  const a = game.attributes ?? {};
  const mapVersion = related(doc, game, "mapVersion");
  const map = mapVersion ? related(doc, mapVersion, "map") : undefined;
  const folder = pick<string>(mapVersion?.attributes, "folderName");
  const generated = isGenerated(folder);
  const mapName = generated ? "Neroxis Map Generator" : pick<string>(map?.attributes, "displayName") ?? folder ?? null;
  const thumb = generated
    ? GENERATED_MAP_PLACEHOLDER
    : pick<string>(mapVersion?.attributes, "thumbnailUrlSmall") ?? (folder ? mapPreviewUrl(folder) : null);
  const modName = pick<string>(related(doc, game, "featuredMod")?.attributes, "technicalName") ?? "";
  const teams = teamsOf(doc, game);
  const players = teams.reduce((n, t) => n + t.players.length, 0);
  const ratings = teams.flatMap((t) => t.players.map((p) => p.rating)).filter((r): r is number => r !== null);
  const average = ratings.length ? Math.round(ratings.reduce((s, r) => s + r, 0) / ratings.length) : null;
  const ticks = pick<number>(a, "replayTicks");
  const start = pick<string>(a, "startTime");
  const startDate = start ? new Date(start) : null;
  const available = pick<boolean>(a, "replayAvailable") !== false;
  const unranked = Boolean(pick<string>(a, "validity")) && pick<string>(a, "validity") !== "VALID";
  const title = pick<string>(a, "name") || mapName || `Game ${game.id}`;

  return (
    <article className="replay-card surface-panel">
      <div className="replay-card-left">
        <MapThumb url={thumb} />
        <div className="replay-meta-grid muted">
          <Fact icon="users" label="Players" value={String(players)} />
          <Fact
            icon="calendar"
            label="Played"
            value={startDate ? startDate.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : ""}
            detail={startDate ? startDate.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }) : undefined}
          />
          <Fact icon="mods" label="Featured mod" value={modName} />
          <Fact icon="activity" label="Average rating" value={average !== null ? `~${average}` : ""} />
          <Fact icon="hourglass" label="Game time" value={duration(typeof ticks === "number" ? ticks / TICKS_PER_SECOND : null)} />
          <Fact icon="clock" label="Real time" value={duration(secondsBetween(start, pick(a, "endTime")))} />
        </div>
      </div>

      <div className="replay-card-right">
        <div className="replay-card-top">
          <div className="replay-card-header">
            <h2 className="replay-card-title" title={title}>
              {title}
            </h2>
            <span className="replay-card-submap muted">
              {mapName ? `on ${mapName}` : "Map unknown"}
              <span className="replay-card-id"> · #{game.id}</span>
              {unranked && <span> · Unranked</span>}
            </span>
          </div>
          {available && (
            <div className="replay-card-corner">
              <a
                className="web-button web-button-primary replay-card-watch"
                href={`${fafUrl("replay")}/${encodeURIComponent(game.id)}`}
                rel="noopener noreferrer"
                title={`Download replay #${game.id}, to watch in the desktop client`}
              >
                <Icon name="download" size={15} />
                <span>Download</span>
              </a>
            </div>
          )}
        </div>
        <Roster teams={teams} me={me} onPlayer={onPlayer} />
        {!available && (
          <div className="replay-card-footer">
            <span className="muted">No replay file for this game</span>
          </div>
        )}
      </div>
    </article>
  );
}
