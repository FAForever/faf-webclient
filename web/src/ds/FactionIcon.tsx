// The four faction glyphs, as the Rust client draws them
// (ui/src/shared/components/FactionIcon.tsx: the Java client's official
// marks), in the faction's own colour. Nomad has no glyph.

import type { SVGProps } from "react";

const FACTION_PATHS: Readonly<Record<number, { path: string; viewBox: string }>> = {
  1: {
    viewBox: "0 1.5 45 55",
    path: "M9 34.5 3.4 28.9 9 23.3l5.6 5.6L9 34.5Zm6.7 6.7-5.6-5.6 5.6-5.6 5.6 5.6-5.6 5.6Zm6.7 6.7-5.6-5.6 5.6-5.6 5.6 5.6-5.6 5.6Zm6.7-6.7-5.6-5.6 5.6-5.6 5.6 5.6-5.6 5.6Zm6.7-6.7-5.6-5.6 5.6-5.6 5.6 5.6-5.6 5.6ZM22.4 34.5 10.1 22.3 22.4 10l12.3 12.3-12.3 12.2Z",
  },
  2: {
    viewBox: "0 1 47 56",
    path: "M23.2 28.7c-3.4 0-6.1-4.9-6.1-10.9 0-3.6 1-6.8 2.5-8.8C13.5 11.6 9 20.5 9 31.1h.4c5.3 0 9.7 3.7 10.7 8.7.4-3.4 1.7-5.9 3.1-5.9s2.7 2.5 3.1 5.9c1-5 5.4-8.7 10.7-8.7h.4c0-10.6-4.5-19.5-10.6-22.1 1.5 2 2.5 5.2 2.5 8.8 0 6-2.7 10.9-6.1 10.9Zm0 7.8c-1 0-1.9 2.7-1.9 6.1s.8 6.1 1.9 6.1 1.9-2.7 1.9-6.1-.9-6.1-1.9-6.1Z",
  },
  3: {
    viewBox: "0 2.75 25 27",
    path: "m12.4 14.9-2.5 4.3h5l-2.5-4.3Zm4.3 4.8 6.5 3.7-3.3-5.6-.7.4-1-1.8 1.7-3h-3.5l-1-1.8.8-.4-3.3-5.7v7.5l3.8 6.7Zm-8.2.9L2 24.3h6.5v-.8h2.1l1.8 3 1.7-3h2.1v.8h6.5l-6.5-3.7H8.5Zm3.3-7.6V5.5l-3.2 5.7.7.4-1 1.8H4.8l1.7 3-1 1.8-.8-.4-3.2 5.6L8 19.7l3.8-6.7Z",
  },
  4: {
    viewBox: "0 2.75 48 56",
    path: "M18.7 35.7c1.1-1.9 3-3.1 5-3.1s3.9 1.2 5 3.1c-.9-3.7-2.8-6.3-5-6.3s-4.1 2.6-5 6.3Zm10.2 5.3c0-3.6-2.3-6.6-5.2-6.6s-5.1 3-5.1 6.6 2.3 6.6 5.1 6.6 5.2-3 5.2-6.6Zm-1 6.3c1.5-1.5 2.5-3.9 2.5-6.5 0-.9-.1-1.8-.3-2.6 0-.7.2-2.2-.4-4.4-.6-2.2-2-3.8-2.8-4.7 1.3-.3 2.4-1.4 3.2-2.7.8-1.4 1.7-3.5 2-7.1.3-3.6-.7-8.3-1.2-10 1.2 1.5 2.9 4.4 4 7.2 1.1 2.7 2.3 7 2.7 10 .5 3 .6 4.9.2 6.9-1.4-.8-2.3-.2-2.7.1-.4.3-1.2 1.2-1.6 2.3-.4 1.1-.6 2.7-.4 3.9.2 1.2.7 1.5 1.1 1.5s1.1-.2 2.6-2c1.5-1.7 2.6-3.8 3-4.9.4-1.1 1-2.8 1.5-4.7.4 3.5-.3 6.9-1.2 9.2-.9 2.4-2.2 4.8-5 7.8-2.7 3.1-5.6 4.9-8.6 5.6.4-.6.8-1.5 1-2.3.3-.9.3-1.8.4-2.6Zm-8.3 0c-1.5-1.5-2.6-3.9-2.6-6.5 0-1 .2-2 .4-2.9-.1-1.3 0-2.1.2-3.2.2-1.1.7-2.4 1.1-3.2-2.5-.8-3.7-2.3-4.4-4-.7-1.6-.9-4.3-.8-6.6.1-2.4.5-4 1-5.5-1.4 1.7-3 4.4-3.7 6-.7 1.7-1.4 4.3-1.6 6.2-.2 1.9-.2 3.7.4 5.8 1.5-.9 2.4-.2 2.7.1.4.3 1.2 1.3 1.7 2.5.4 1.3.5 2.5.3 3.7-.2 1.1-.7 1.4-1.1 1.4s-1.1-.2-2.6-1.9c-1.5-1.8-2.6-3.9-3-5-.4-1-.9-2.5-1.3-4.5-.5 3.4 0 6.1 1 9 1.1 2.9 3.3 5.8 5 7.8 1.7 2 4.6 4.5 8.6 5.6-.5-.9-.7-1.5-1-2.5-.2-.9-.3-1.7-.3-2.4Z",
  },
};

const COLORS: Record<number, string> = {
  1: "var(--color-faction-uef)",
  2: "var(--color-faction-aeon)",
  3: "var(--color-faction-cybran)",
  4: "var(--color-faction-seraphim)",
};

// The API's Faction enum (faf-java-api): 5 is Nomad there, not "random", because a
// finished game records what was played.
export const FACTION_NAMES: Record<number, string> = { 1: "UEF", 2: "Aeon", 3: "Cybran", 4: "Seraphim", 5: "Nomad" };

/** A faction as FAF's API sends it, a number or a word, as the game's id (1 UEF ... 4 Seraphim). */
export function factionId(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isInteger(n) && n > 0) return n;
  const word = String(value).toLowerCase();
  const found = Object.entries(FACTION_NAMES).find(([, name]) => name.toLowerCase() === word);
  return found ? Number(found[0]) : null;
}

export const hasGlyph = (faction: number) => Boolean(FACTION_PATHS[faction]);

export function FactionIcon({ faction, size = 16, style, ...props }: Omit<SVGProps<SVGSVGElement>, "children"> & { faction: number; size?: number }) {
  const glyph = FACTION_PATHS[faction];
  if (!glyph) return null;
  return (
    <svg
      aria-label={FACTION_NAMES[faction]}
      role="img"
      height={size}
      width={size}
      viewBox={glyph.viewBox}
      shapeRendering="geometricPrecision"
      fill="currentColor"
      style={{ color: COLORS[faction], flex: "none", ...style }}
      {...props}
    >
      <title>{FACTION_NAMES[faction]}</title>
      <path d={glyph.path} />
    </svg>
  );
}
