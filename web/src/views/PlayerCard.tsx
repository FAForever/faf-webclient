// A player's card, opened from a name on the leaderboard: who they are, their
// clan, and their rating on every board, with the way on to their replays and,
// when logged in, to a private chat. The parts of the Rust client's leaderboard
// player panel (ui/src/features/leaderboard/PlayerDetailsPanel.tsx) and player
// card that need no account.

import { useEffect, useRef, useState } from "react";
import { fafPath, formatDate, pick, related, type JsonApiDocument, type JsonApiResource } from "../api";
import { getSession } from "../auth";
import { chat } from "../chat/client";
import { Icon } from "../ds/Icon";
import { go } from "../nav";
import { LoadFailed, Loading, useJson } from "./common";

// The Rust client's names for the boards (ui/src/shared/playerRatings.ts).
const BOARD_LABELS: Record<string, string> = {
  global: "Global",
  ladder_1v1: "1v1",
  ladder1v1: "1v1",
  tmm_2v2: "2v2",
  ladder2v2: "2v2",
  tmm_3v3: "3v3",
  ladder3v3: "3v3",
  tmm_4v4: "4v4",
  tmm_4v4_full_share: "4v4",
  ladder4v4: "4v4",
  "4v4_full_share": "4v4",
  tmm_4v4_share_until_death: "4v4 No Share",
  "4v4_share_until_death": "4v4 No Share",
};
const BOARD_ORDER = ["global", "ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4_full_share", "tmm_4v4_share_until_death"];

function boardLabel(name: string): string {
  return (
    BOARD_LABELS[name] ??
    name
      .replace(/^(tmm|ladder)_/, "")
      .replace(/_/g, " ")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function boardRank(name: string): number {
  const index = BOARD_ORDER.indexOf(name);
  return index < 0 ? BOARD_ORDER.length : index;
}

interface Rating {
  board: string;
  rating: number | null;
  games: number;
  won: number | null;
}

function ratingsOf(doc: JsonApiDocument): Rating[] {
  return (doc.data ?? [])
    .map((entry: JsonApiResource) => {
      const a = entry.attributes ?? {};
      const board = pick<string>(related(doc, entry, "leaderboard")?.attributes, "technicalName") ?? "?";
      const rating = pick<number>(a, "rating");
      return {
        board,
        rating: typeof rating === "number" ? Math.round(rating) : null,
        games: pick<number>(a, "totalGames") ?? 0,
        won: pick<number>(a, "wonGames") ?? null,
      };
    })
    .filter((r) => r.games > 0)
    .sort((x, y) => boardRank(x.board) - boardRank(y.board) || x.board.localeCompare(y.board));
}

function avatarOf(doc: JsonApiDocument, player: JsonApiResource): { url: string; tooltip?: string } | null {
  const refs = player.relationships?.avatarAssignments?.data;
  for (const ref of Array.isArray(refs) ? refs : []) {
    const assignment = doc.included?.find((i) => i.type === ref.type && i.id === ref.id);
    if (!assignment || pick<boolean>(assignment.attributes, "selected") !== true) continue;
    const avatar = related(doc, assignment, "avatar");
    const url = pick<string>(avatar?.attributes, "url");
    if (url) return { url, tooltip: pick<string>(avatar?.attributes, "tooltip") };
  }
  return null;
}

export function PlayerCard({ id, name, onClose }: { id: number | string; name: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const player = useJson<JsonApiDocument>(
    fafPath("player", { filter: `id==${id}`, include: "avatarAssignments.avatar,clanMembership.clan" }),
  );
  const ratings = useJson<JsonApiDocument>(
    fafPath("leaderboardRating", { filter: `player.id==${id}`, include: "leaderboard", "page[size]": "20" }),
  );

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const profile = player.state === "ready" ? player.data.data?.[0] : undefined;
  const login = pick<string>(profile?.attributes, "login") ?? name;
  const clan = profile && player.state === "ready" ? (() => {
    const membership = related(player.data, profile, "clanMembership");
    return membership ? related(player.data, membership, "clan") : undefined;
  })() : undefined;
  const avatar = profile && player.state === "ready" ? avatarOf(player.data, profile) : null;
  const since = pick<string>(profile?.attributes, "createTime");
  const loggedIn = Boolean(getSession());
  const isMe = getSession()?.user.name.toLowerCase() === login.toLowerCase();

  return (
    <div className="web-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="web-dialog web-player-card" role="dialog" aria-modal="true" aria-labelledby="player-card-name">
        <header className="web-player-head">
          {avatar && <img className="web-player-avatar" src={avatar.url} alt="" title={avatar.tooltip} />}
          <div className="web-player-title">
            <h2 id="player-card-name">
              {clan && <span className="web-player-clan">[{pick<string>(clan.attributes, "tag")}]</span>} {login}
              <button
                type="button"
                className="web-icon-button"
                aria-label={copied ? "Name copied" : "Copy name"}
                title={copied ? "Copied" : "Copy name"}
                onClick={() => {
                  void navigator.clipboard?.writeText(login).then(() => setCopied(true), () => undefined);
                }}
              >
                <Icon name={copied ? "check" : "copy"} size={14} />
              </button>
            </h2>
            <p className="muted">
              {clan ? `${pick<string>(clan.attributes, "name") ?? ""}` : ""}
              {clan && since ? " · " : ""}
              {since ? `Playing since ${formatDate(since)}` : ""}
            </p>
          </div>
          <button ref={closeRef} type="button" className="web-icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        {(ratings.state === "loading" || player.state === "loading") && <Loading what="the player" />}
        {player.state === "error" && <LoadFailed icon="users" what="this player" status={player.status} code={player.code} />}
        {ratings.state === "ready" &&
          (ratingsOf(ratings.data).length === 0 ? (
            <p className="muted">No rated games yet.</p>
          ) : (
            <table className="web-table web-player-ratings">
              <thead>
                <tr>
                  <th>Board</th>
                  <th className="num">Rating</th>
                  <th className="num">Games</th>
                  <th className="num">Won</th>
                </tr>
              </thead>
              <tbody>
                {ratingsOf(ratings.data).map((r) => (
                  <tr key={r.board}>
                    <td>{boardLabel(r.board)}</td>
                    <td className="num">{r.rating ?? "-"}</td>
                    <td className="num muted">{r.games}</td>
                    <td className="num muted">{r.won != null && r.games > 0 ? `${Math.round((r.won / r.games) * 100)}%` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}

        <div className="web-player-actions">
          <button
            type="button"
            className="web-button"
            onClick={() => {
              onClose();
              go(`/replays?player=${encodeURIComponent(login)}`);
            }}
          >
            <Icon name="replays" size={15} /> Recent replays
          </button>
          {loggedIn && !isMe && (
            <button
              type="button"
              className="web-button"
              onClick={() => {
                onClose();
                go("/chat");
                chat.openPrivate(login);
              }}
            >
              <Icon name="chat" size={15} /> Message
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
