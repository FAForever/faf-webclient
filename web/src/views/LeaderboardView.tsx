import { useEffect, useState } from "react";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

// The boards faforever.com publishes (FAForever/website, leaderboardRouter.js).
const BOARDS = [
  { id: "global", label: "Global" },
  { id: "1v1", label: "1v1" },
  { id: "2v2", label: "2v2" },
  { id: "3v3", label: "3v3" },
  { id: "4v4", label: "4v4" },
] as const;

/** One page from server.js's /api/leaderboard route (lib/leaderboard.js). */
interface LeaderboardPage {
  total: number;
  page: number;
  pages: number;
  // rank is null for a search result when the page came from FAF's API.
  rows: { rank: number | null; playerId: number | null; name: string; rating: number | null; games: number | null; won: number | null }[];
}

function winRate(won: number | null, games: number | null): string {
  if (won == null || !games) return "-";
  return `${Math.round((won / games) * 100)}%`;
}

export function LeaderboardView() {
  const [board, setBoard] = useState<string>("global");
  const [page, setPage] = useState(1);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(typed.trim());
      setPage(1);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const params = new URLSearchParams({ page: String(page) });
  if (search) params.set("q", search);
  const load = useJson<LeaderboardPage>(`/api/leaderboard/${board}?${params}`);

  return (
    <div className="web-view">
      <ViewHeader title="Leaderboard" description="Players rated in the last 12 months, highest first." />
      <div className="web-toolbar">
        <div className="web-segmented" role="tablist" aria-label="Leaderboard">
          {BOARDS.map((b) => (
            <button
              key={b.id}
              role="tab"
              aria-selected={board === b.id}
              className={board === b.id ? "is-active" : ""}
              onClick={() => {
                setBoard(b.id);
                setPage(1);
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
        <label className="web-search">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Find a player" value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>
      </div>

      {load.state === "loading" && <Loading what="the leaderboard" />}
      {load.state === "error" && <LoadFailed icon="leaderboard" what="the leaderboard" status={load.status} code={load.code} />}
      {load.state === "ready" &&
        (load.data.rows.length === 0 ? (
          <EmptyState icon="search" title="No players found" hint={search ? `Nobody on this board matches "${search}".` : undefined} bordered />
        ) : (
          <>
            <table className="web-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Player</th>
                  <th className="num">Rating</th>
                  <th className="num">Games</th>
                  <th className="num">Won</th>
                </tr>
              </thead>
              <tbody>
                {load.data.rows.map((row, index) => (
                  <tr key={row.playerId ?? `row-${index}`}>
                    <td className="num muted">{row.rank ?? "-"}</td>
                    <td>{row.name}</td>
                    <td className="num">{row.rating ?? "-"}</td>
                    <td className="num muted">{row.games ?? "-"}</td>
                    <td className="num muted">{winRate(row.won, row.games)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="web-pager">
              <button className="web-button" disabled={load.data.page <= 1} onClick={() => setPage(load.data.page - 1)}>
                Previous
              </button>
              <span className="muted">
                Page {load.data.page} of {load.data.pages}
              </span>
              <button className="web-button" disabled={load.data.page >= load.data.pages} onClick={() => setPage(load.data.page + 1)}>
                Next
              </button>
            </div>
          </>
        ))}
    </div>
  );
}
