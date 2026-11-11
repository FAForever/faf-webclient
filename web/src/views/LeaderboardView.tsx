import { useState } from "react";
import { fafPath, pick, related, type JsonApiDocument } from "../api";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

const BOARDS = [
  { id: "global", label: "Global" },
  { id: "ladder_1v1", label: "1v1" },
  { id: "tmm_2v2", label: "2v2" },
  { id: "tmm_4v4_full_share", label: "4v4 Full Share" },
] as const;

const PAGE_SIZE = 50;

export function LeaderboardView() {
  const [board, setBoard] = useState<string>("global");
  const [page, setPage] = useState(1);
  const path = fafPath("leaderboardRating", {
    include: "player",
    filter: `leaderboard.technicalName=="${board}"`,
    sort: "-rating",
    "page[size]": String(PAGE_SIZE),
    "page[number]": String(page),
    "page[totals]": "",
  });
  const load = useJson<JsonApiDocument>(path);
  const totalPages = load.state === "ready" ? load.data.meta?.page?.totalPages : undefined;

  return (
    <div className="web-view">
      <ViewHeader title="Leaderboard" description="Top rated players." />
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

      {load.state === "loading" && <Loading what="the leaderboard" />}
      {load.state === "error" && <LoadFailed icon="leaderboard" what="the leaderboard" status={load.status} />}
      {load.state === "ready" && (
        <>
          <table className="web-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Player</th>
                <th className="num">Rating</th>
                <th className="num">Games</th>
              </tr>
            </thead>
            <tbody>
              {(load.data.data ?? []).map((row, index) => {
                const a = row.attributes ?? {};
                const player = related(load.data, row, "player");
                const rating = pick<number>(a, "rating", "meanRating");
                return (
                  <tr key={row.id}>
                    <td className="num muted">{(page - 1) * PAGE_SIZE + index + 1}</td>
                    <td>{pick<string>(player?.attributes, "login") ?? "-"}</td>
                    <td className="num">{rating != null ? Math.round(rating) : "-"}</td>
                    <td className="num muted">{pick<number>(a, "totalGames") ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="web-pager">
            <button className="web-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="muted">
              Page {page}
              {totalPages ? ` of ${totalPages}` : ""}
            </span>
            <button
              className="web-button"
              disabled={totalPages != null && page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
