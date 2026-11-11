import { mapPreviewUrl, timeAgo } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

/** One open lobby, as published by the lobby server's public `GET /games`. */
interface PublicGame {
  uid: number;
  title: string;
  game_type: string;
  featured_mod: string;
  sim_mods: Record<string, string>;
  mapname: string;
  host: string;
  num_players: number;
  max_players: number;
  password_protected: boolean;
  hosted_at: string | null;
  rating_min: number | null;
  rating_max: number | null;
  enforce_rating_range: boolean;
  teams: Record<string, string[]>;
}

function ratingRange(game: PublicGame): string | null {
  const { rating_min: min, rating_max: max } = game;
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min} to ${max}`;
  return min != null ? `${min}+` : `up to ${max}`;
}

function LobbyCard({ game }: { game: PublicGame }) {
  const range = ratingRange(game);
  const mods = Object.values(game.sim_mods ?? {});
  const teams = Object.entries(game.teams ?? {}).filter(([, players]) => players.length > 0);
  const full = game.num_players >= game.max_players;

  return (
    <article className="web-card web-lobby">
      <img
        className="web-lobby-preview"
        src={mapPreviewUrl(game.mapname)}
        alt=""
        loading="lazy"
        onError={(event) => event.currentTarget.classList.add("is-missing")}
      />
      <div className="web-lobby-body">
        <h2 className="web-card-title">
          {game.password_protected && <Icon name="lock" size={14} />}
          <span>{game.title}</span>
        </h2>
        <p className="muted web-lobby-map">{game.mapname}</p>
        <div className="web-chips">
          <span className={`web-chip ${full ? "is-full" : "is-open"}`}>
            <Icon name="users" size={13} /> {game.num_players} / {game.max_players}
          </span>
          {game.featured_mod !== "faf" && <span className="web-chip">{game.featured_mod}</span>}
          {range && (
            <span className="web-chip">
              <Icon name="leaderboard" size={13} /> {range}
              {game.enforce_rating_range ? " (enforced)" : ""}
            </span>
          )}
          {mods.length > 0 && <span className="web-chip">{mods.length === 1 ? mods[0] : `${mods.length} mods`}</span>}
        </div>
        <p className="web-lobby-host muted">
          Hosted by <strong>{game.host}</strong>
          {game.hosted_at ? `, ${timeAgo(game.hosted_at)}` : ""}
        </p>
        {teams.length > 0 && (
          <ul className="web-teams">
            {teams.map(([team, players]) => (
              <li key={team}>
                <span className="web-team-label">{team === "1" ? "No team" : `Team ${Number(team) - 1}`}</span>
                {players.join(", ")}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

export function PlayView() {
  const load = useJson<{ games: PublicGame[] }>("/api/lobby/games", 5000);

  return (
    <div className="web-view">
      <ViewHeader title="Play" description="Open lobbies right now. Updates every few seconds." />
      {load.state === "loading" && <Loading what="open lobbies" />}
      {load.state === "error" &&
        (load.status === 404 || load.status === 502 ? (
          <EmptyState
            icon="play"
            title="Open lobbies aren't available yet"
            hint="This needs FAF's public lobby list, which isn't live yet."
            bordered
          />
        ) : (
          <LoadFailed icon="play" what="open lobbies" status={load.status} />
        ))}
      {load.state === "ready" &&
        (load.data.games.length === 0 ? (
          <EmptyState icon="play" title="No open lobbies" hint="Nobody is hosting a public game right now." bordered />
        ) : (
          <>
            <p className="muted web-count">
              {load.data.games.length} open {load.data.games.length === 1 ? "lobby" : "lobbies"}
            </p>
            <div className="web-grid">
              {[...load.data.games]
                .sort((a, b) => b.num_players - a.num_players)
                .map((game) => (
                  <LobbyCard key={game.uid} game={game} />
                ))}
            </div>
          </>
        ))}
    </div>
  );
}
