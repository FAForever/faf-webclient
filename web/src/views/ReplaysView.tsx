import { useEffect, useState, useSyncExternalStore } from "react";
import { fafPath, type JsonApiDocument } from "../api";
import { beginLogin, getSession, siteConfig, subscribeSession } from "../auth";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { fafUrl } from "../hosts";
import { ReplayCard, type ReplayPlayer } from "../replays/ReplayCard";
import "../replays/replays.css";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";
import { PlayerCard } from "./PlayerCard";

const PAGE_SIZE = 24;

/**
 * The replay ID in whatever was typed or pasted: "25001234", "#25001234", or a
 * replay link. Null until it looks like one.
 */
function replayIdFrom(text: string): string | null {
  const match = text.trim().match(/(?:^|[^0-9])([0-9]{1,10})(?:[^0-9]*)$/);
  return match ? match[1] : null;
}

/**
 * Works without any login: replay.faforever.com/<id> redirects to the API's
 * replay download, the one API route open to everyone (gitops-stack
 * apps/faf-content ingress, faf-java-api WebSecurityConfig).
 */
function DownloadById() {
  const [text, setText] = useState("");
  const id = replayIdFrom(text);
  const href = id ? `${fafUrl("replay")}/${id}` : undefined;

  return (
    <form
      className="replay-filter replay-filter-id"
      onSubmit={(event) => {
        event.preventDefault();
        if (href) window.location.href = href;
      }}
    >
      <label className="replay-filter-label" htmlFor="replay-id">
        Replay ID
      </label>
      <div className="replay-filter-row">
        <input
          id="replay-id"
          className="web-input"
          inputMode="numeric"
          autoComplete="off"
          placeholder="25001234 or a replay link"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <a
          className={`web-button${href ? " web-button-primary" : " is-disabled"}`}
          href={href}
          aria-disabled={!href}
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!href) event.preventDefault();
          }}
        >
          <Icon name="download" size={15} /> Download
        </a>
      </div>
    </form>
  );
}

/**
 * A player handed over in the address: /replays?player=Name from a player
 * card, or /replays?mine=1 on the way back from a login started by "My
 * replays", which is the logged-in player.
 */
function playerFromAddress(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.has("mine")) return getSession()?.user.name ?? "";
  return params.get("player")?.slice(0, 40) ?? "";
}

export function ReplaysView() {
  const [typed, setTyped] = useState(playerFromAddress);
  const [player, setPlayer] = useState(playerFromAddress);
  const [page, setPage] = useState(1);
  const session = useSyncExternalStore(subscribeSession, getSession);
  const me = session?.user.name ?? "";
  const [canLogin, setCanLogin] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [openPlayer, setOpenPlayer] = useState<ReplayPlayer | null>(null);

  useEffect(() => {
    let alive = true;
    siteConfig()
      .then((config) => alive && setCanLogin(Boolean(config.login)))
      .catch(() => undefined);
    // "?mine" has done its job once read; the address stays shareable without it.
    if (new URLSearchParams(window.location.search).has("mine")) window.history.replaceState(null, "", "/replays");
    return () => {
      alive = false;
    };
  }, []);

  // "Recent replays" on a player card opened from this tab: same tab, new player.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== "/replays") return;
      const name = playerFromAddress();
      setTyped(name);
      setPlayer(name);
      setPage(1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const showing = (name: string) => {
    setTyped(name);
    setPlayer(name);
    setPage(1);
  };

  const mine = Boolean(me) && player.toLowerCase() === me.toLowerCase();
  const onMine = () => {
    if (me) {
      showing(mine ? "" : me);
      return;
    }
    // Not logged in: FAF's login page, then back here with the name filled in.
    setLoginError("");
    beginLogin("/replays?mine=1").catch((err: unknown) => setLoginError(err instanceof Error ? err.message : "The login could not start."));
  };

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
    <div className="web-view web-view-replays">
      <ViewHeader title="Replays" description="Recently finished games. Download a replay to watch it in the desktop client." />
      <div className="replay-filters surface-panel">
        <div className="replay-filter replay-filter-player">
          <label className="replay-filter-label" htmlFor="replay-player">
            Player
          </label>
          <div className="replay-filter-row">
            <input
              id="replay-player"
              className="web-input"
              type="search"
              placeholder="Exact player name"
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            {(me || canLogin) && (
              <button
                type="button"
                className={`web-button${mine ? " is-active" : ""}`}
                aria-pressed={mine}
                onClick={onMine}
                title={me ? `Games played by ${me}` : "Log in with your FAF account to see your own games"}
              >
                <Icon name="user" size={14} /> My replays
              </button>
            )}
          </div>
        </div>
        <DownloadById />
      </div>
      {loginError && <p className="muted">{loginError}</p>}

      {load.state === "loading" && <Loading what="replays" />}
      {load.state === "error" && <LoadFailed icon="replays" what="replays" status={load.status} code={load.code} />}
      {load.state === "ready" &&
        (games.length === 0 ? (
          <EmptyState icon="replays" title="No replays found" hint={player ? `No finished games for "${player}".` : undefined} bordered />
        ) : (
          <>
            <div className="replay-grid">
              {games.map((game) => (
                <ReplayCard key={game.id} doc={load.data} game={game} me={me} onPlayer={setOpenPlayer} />
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
      {openPlayer?.id && <PlayerCard id={openPlayer.id} name={openPlayer.name} onClose={() => setOpenPlayer(null)} />}
    </div>
  );
}
