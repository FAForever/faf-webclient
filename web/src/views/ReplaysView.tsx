// The Replays tab: FAF's finished games, searchable the way the Rust client's
// online replay vault is (replays/ReplayFilters.tsx, replays/query.ts), as
// cards like its own (replays/ReplayCard.tsx). A replay downloads from
// replay.faforever.com/<id>, which needs no login.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fafPath, pick, type JsonApiDocument } from "../api";
import { beginLogin, getSession, siteConfig, subscribeSession } from "../auth";
import { boardLabel, boardRank } from "../boards";
import { EmptyState } from "../ds/EmptyState";
import { ReplayCard, type ReplayPlayer } from "../replays/ReplayCard";
import { ReplayFilters, type Mode } from "../replays/ReplayFilters";
import { acceptsPlayerCount, buildFilter, COOP, EMPTY_QUERY, hasLocalFilter, sortParam, type ReplayQuery } from "../replays/query";
import "../replays/replays.css";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";
import { PlayerCard } from "./PlayerCard";

const PAGE_SIZE = 24;

// When FAF's list of boards cannot be read: the ones there are today.
const FALLBACK_BOARDS = ["global", "ladder_1v1", "tmm_2v2", "tmm_4v4_full_share", "tmm_4v4_share_until_death"];

function modesFrom(boards: string[]): Mode[] {
  const names = boards.includes("global") ? boards : ["global", ...boards];
  return [
    ...[...names].sort((a, b) => boardRank(a) - boardRank(b)).map((id) => ({ id, label: id === "global" ? "Custom games" : boardLabel(id) })),
    { id: COOP, label: "Co-op" },
  ];
}

/**
 * The search a link asks for: /replays?player=Name from a player card, or
 * /replays?mine=1 on the way back from a login started by "My replays".
 */
function queryFromAddress(): ReplayQuery {
  const params = new URLSearchParams(window.location.search);
  const player = params.has("mine") ? getSession()?.user.name ?? "" : params.get("player")?.slice(0, 40) ?? "";
  return { ...EMPTY_QUERY, player };
}

export function ReplaysView() {
  const [applied, setApplied] = useState(queryFromAddress);
  const [draft, setDraft] = useState(applied);
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

  const apply = (next: ReplayQuery = draft) => {
    setApplied(next);
    setDraft(next);
    setPage(1);
  };

  // "Recent replays" on a player card opened from this tab: same tab, new player.
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== "/replays") return;
      const next = queryFromAddress();
      setApplied(next);
      setDraft(next);
      setPage(1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loginForMine = () => {
    // FAF's login page, then back here with the name filled in.
    setLoginError("");
    beginLogin("/replays?mine=1").catch((err: unknown) => setLoginError(err instanceof Error ? err.message : "The login could not start."));
  };

  const boards = useJson<JsonApiDocument>(fafPath("leaderboard", { "page[size]": "50" }));
  const modes = useMemo(() => {
    const names = boards.state === "ready" ? (boards.data.data ?? []).map((b) => pick<string>(b.attributes, "technicalName")).filter((n): n is string => Boolean(n)) : [];
    return modesFrom(names.length ? names : FALLBACK_BOARDS);
  }, [boards]);

  // Same include list as the Rust client's replay vault (infra/replay/vault.rs), minus avatars and reviews.
  const load = useJson<JsonApiDocument>(
    fafPath("game", {
      include: "mapVersion,mapVersion.map,featuredMod,playerStats,playerStats.player",
      sort: sortParam(applied),
      filter: buildFilter(applied),
      "page[size]": String(PAGE_SIZE),
      "page[number]": String(page),
    }),
  );
  const all = load.state === "ready" ? load.data.data ?? [] : [];
  const games = all.filter((game) => {
    const stats = game.relationships?.playerStats?.data;
    return acceptsPlayerCount(applied, Array.isArray(stats) ? stats.length : 0);
  });
  const local = hasLocalFilter(applied);

  return (
    <div className="web-view web-view-replays">
      <ViewHeader title="Replays" description="Finished games. Download a replay to watch it in the desktop client." />
      <ReplayFilters draft={draft} setDraft={setDraft} apply={apply} modes={modes} me={me} canLogin={canLogin} onLoginForMine={loginForMine} />
      {loginError && <p className="muted">{loginError}</p>}

      {load.state === "loading" && <Loading what="replays" />}
      {load.state === "error" && <LoadFailed icon="replays" what="replays" status={load.status} code={load.code} />}
      {load.state === "ready" && (
        <>
          {local && (
            <p className="muted replay-search-note">
              "Players in the game" is checked on each page of {PAGE_SIZE}, so a page can show fewer games: {games.length} of {all.length} here.
            </p>
          )}
          {games.length === 0 ? (
            <EmptyState
              icon="replays"
              title="No replays found"
              hint={applied.recentOnly && !applied.after ? "Only the last year is searched. Untick \"Recent only\" to search all of FAF's history." : "Try fewer filters."}
              bordered
            />
          ) : (
            <div className="replay-grid">
              {games.map((game) => (
                <ReplayCard key={game.id} doc={load.data} game={game} me={me} onPlayer={setOpenPlayer} />
              ))}
            </div>
          )}
          {(page > 1 || all.length >= PAGE_SIZE) && (
            <div className="web-pager">
              <button className="web-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted">Page {page}</span>
              <button className="web-button" disabled={all.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
      {openPlayer?.id && <PlayerCard id={openPlayer.id} name={openPlayer.name} onClose={() => setOpenPlayer(null)} />}
    </div>
  );
}
