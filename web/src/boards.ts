// FAF's rating boards: what the players call them and the order they come in.

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
export const BOARD_ORDER = ["global", "ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4_full_share", "tmm_4v4_share_until_death"];

export function boardLabel(name: string): string {
  return (
    BOARD_LABELS[name] ??
    name
      .replace(/^(tmm|ladder)_/, "")
      .replace(/_/g, " ")
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function boardRank(name: string): number {
  const index = BOARD_ORDER.indexOf(name);
  return index < 0 ? BOARD_ORDER.length : index;
}
