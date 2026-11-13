import { useState, type FormEvent } from "react";
import { mapPreviewUrl, timeAgo } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { sendCommand, useLink } from "../link/link";
import { PcPanel } from "../link/PcPanel";
import type { PcGame } from "../link/protocol";
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

/** The public list and the PC's list, in one shape. */
type Lobby = PcGame;

function fromPublic(game: PublicGame): Lobby {
  return {
    id: game.uid,
    title: game.title,
    host: game.host,
    map: game.mapname,
    mod: game.featured_mod,
    players: game.num_players,
    maxPlayers: game.max_players,
    passwordProtected: game.password_protected,
    ratingMin: game.rating_min,
    ratingMax: game.rating_max,
    enforceRating: game.enforce_rating_range,
    simMods: Object.values(game.sim_mods ?? {}),
    teams: game.teams ?? {},
    hostedAt: game.hosted_at,
  };
}

function ratingRange(game: Lobby): string | null {
  const { ratingMin: min, ratingMax: max } = game;
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min} to ${max}`;
  return min != null ? `${min}+` : `up to ${max}`;
}

function LobbyCard({ game, onJoin }: { game: Lobby; onJoin?: (game: Lobby) => void }) {
  const range = ratingRange(game);
  const teams = Object.entries(game.teams ?? {}).filter(([, players]) => players.length > 0);
  const full = game.players >= game.maxPlayers;

  return (
    <article className="web-card web-lobby">
      <img
        className="web-lobby-preview"
        src={mapPreviewUrl(game.map)}
        alt=""
        loading="lazy"
        onError={(event) => event.currentTarget.classList.add("is-missing")}
      />
      <div className="web-lobby-body">
        <h2 className="web-card-title">
          {game.passwordProtected && <Icon name="lock" size={14} />}
          <span>{game.title}</span>
        </h2>
        <p className="muted web-lobby-map">{game.map}</p>
        <div className="web-chips">
          <span className={`web-chip ${full ? "is-full" : "is-open"}`}>
            <Icon name="users" size={13} /> {game.players} / {game.maxPlayers}
          </span>
          {game.mod !== "faf" && <span className="web-chip">{game.mod}</span>}
          {range && (
            <span className="web-chip">
              <Icon name="leaderboard" size={13} /> {range}
              {game.enforceRating ? " (enforced)" : ""}
            </span>
          )}
          {game.simMods.length > 0 && <span className="web-chip">{game.simMods.length === 1 ? game.simMods[0] : `${game.simMods.length} mods`}</span>}
        </div>
        <p className="web-lobby-host muted">
          Hosted by <strong>{game.host}</strong>
          {game.hostedAt ? `, ${timeAgo(game.hostedAt)}` : ""}
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
        {onJoin && (
          <div className="web-lobby-actions">
            <button type="button" className="web-button web-button-primary web-lobby-join" disabled={full} onClick={() => onJoin(game)}>
              <Icon name="monitor" size={15} /> {full ? "Full" : "Join on my PC"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * The PC took the request, which is all that is known yet: the join can still
 * stop at the mod replacement prompt on the PC, or be refused by the server.
 * Either comes back as "Your PC needs you" (MatchBanner) and in the panel.
 */
function askedToJoin(title: string): string {
  return `Asked your PC to join "${title}".`;
}

/** Asks for the password, then asks the PC to join. */
function JoinDialog({ game, onClose }: { game: Lobby; onClose: (message?: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    const result = await sendCommand({ action: "joinGame", gameId: game.id, password: password || undefined });
    setBusy(false);
    if (result.ok) onClose(askedToJoin(game.title));
    else setProblem(result.error ?? "Your PC refused.");
  };

  return (
    <div className="web-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="web-dialog pc-join-form" role="dialog" aria-modal="true" aria-labelledby="join-title" onSubmit={(event) => void submit(event)}>
        <h2 id="join-title">Join "{game.title}"</h2>
        <p className="muted pc-note">The game starts on your PC. This lobby needs a password.</p>
        <input
          className="web-input"
          type="password"
          autoFocus
          autoComplete="off"
          maxLength={100}
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {problem && <p className="pc-problem">{problem}</p>}
        <div className="pc-join-buttons">
          <button type="button" className="web-button" onClick={() => onClose()}>
            Cancel
          </button>
          <button type="submit" className="web-button web-button-primary" disabled={busy || !password}>
            Join on my PC
          </button>
        </div>
      </form>
    </div>
  );
}

function LobbyGrid({ games, onJoin }: { games: Lobby[]; onJoin?: (game: Lobby) => void }) {
  if (games.length === 0) return <EmptyState icon="play" title="No open lobbies" hint="Nobody is hosting a public game right now." bordered />;
  return (
    <>
      <p className="muted web-count">
        {games.length} open {games.length === 1 ? "lobby" : "lobbies"}
      </p>
      <div className="web-grid">
        {[...games]
          .sort((a, b) => b.players - a.players)
          .map((game) => (
            <LobbyCard key={game.id} game={game} onJoin={onJoin} />
          ))}
      </div>
    </>
  );
}

export function PlayView() {
  const link = useLink();
  const fromPc = link.status === "ready" && link.pc.connected && link.games !== null;
  // The public list only while the PC's own list is not there.
  const load = useJson<{ games: PublicGame[] }>(fromPc ? null : "/api/lobby/games", 5000);
  const [joining, setJoining] = useState<Lobby | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  const join = async (game: Lobby) => {
    setNotice(null);
    if (game.passwordProtected) {
      setJoining(game);
      return;
    }
    const result = await sendCommand({ action: "joinGame", gameId: game.id });
    setNotice(result.ok ? { text: askedToJoin(game.title), ok: true } : { text: result.error ?? "Your PC refused.", ok: false });
  };

  return (
    <div className="web-view">
      <ViewHeader title="Play" description={fromPc ? "Open lobbies, from the FAF client on your PC." : "Open lobbies right now. Updates every few seconds."} />
      <PcPanel />
      {notice && (
        <p className={notice.ok ? "muted web-lobby-source" : "pc-problem web-lobby-source"} role="status">
          {notice.text}
        </p>
      )}
      {fromPc ? (
        <LobbyGrid games={link.games ?? []} onJoin={(game) => void join(game)} />
      ) : (
        <>
          {load.state === "loading" && <Loading what="open lobbies" />}
          {load.state === "error" &&
            (load.status === 404 || load.status === 502 ? (
              <EmptyState
                icon="play"
                title="Open lobbies aren't available yet"
                hint="This needs FAF's public lobby list, which isn't live yet. With your PC connected above, its lobby list shows here instead."
                bordered
              />
            ) : (
              <LoadFailed icon="play" what="open lobbies" status={load.status} />
            ))}
          {load.state === "ready" && <LobbyGrid games={load.data.games.map(fromPublic)} />}
        </>
      )}
      {joining && (
        <JoinDialog
          game={joining}
          onClose={(message) => {
            setJoining(null);
            if (message) setNotice({ text: message, ok: true });
          }}
        />
      )}
    </div>
  );
}
