// The PC link: what the FAF Rust client on the player's PC sends through this
// site (lib/link.js), and what the page may ask it to do.
//
// The shapes are the Rust client's (crates/faf-domain/src/protocol/web_link.rs
// in its repository): it builds them from its own state, this site only passes
// them on. Version 1.

export const LINK_VERSION = 1;

/** The PC as the server describes it to a browser. */
export interface PcInfo {
  connected: boolean;
  /** "FAF Rust client 1.4.0", say. */
  client?: string;
  /** The computer's name, as the client chose to report it. */
  device?: string;
  /** The FAF account it is logged in as. */
  name?: string;
}

export type MatchmakingStatus = "idle" | "preparing" | "searching" | "matchFound" | "launching" | "cancelled";

export interface PcQueue {
  /** Technical name, as the commands take it: "ladder1v1", "tmm2v2", ... */
  name: string;
  teamSize: number;
  /** Players searching in it right now. */
  playersInQueue: number;
  /** When the queue next pops (ISO 8601), when the server said. */
  popsAt: string | null;
}

export interface PcFriend {
  name: string;
  online: boolean;
  /** The game they are in, open or running. */
  game: { id: number; title: string; status: "lobby" | "playing" } | null;
}

export interface PcState {
  player: { id: number; name: string } | null;
  /** The client's connection to FAF's lobby server. */
  lobby: "connected" | "connecting" | "disconnected";
  queues: PcQueue[];
  matchmaking: { status: MatchmakingStatus; queues: string[] };
  party: { ownerId: number | null; members: { id: number; name: string }[] };
  /** The game this PC is joining or playing, if any. */
  game: { id: number | null; title: string; status: "joining" | "preparing" | "launched" | "lobby" | "playing" } | null;
  /** Everyone on the friends list, online first. */
  friends: PcFriend[];
}

/** One open lobby, from the PC's own lobby list. */
export interface PcGame {
  id: number;
  title: string;
  host: string;
  map: string;
  /** Featured mod's technical name ("faf", "fafbeta", ...). */
  mod: string;
  players: number;
  maxPlayers: number;
  passwordProtected: boolean;
  ratingMin: number | null;
  ratingMax: number | null;
  enforceRating: boolean;
  /** Sim mods' display names. */
  simMods: string[];
  /** Team number to logins; "1" is no team. */
  teams: Record<string, string[]>;
  hostedAt: string | null;
}

export type LinkCommand =
  | { action: "startSearch"; queues: string[] }
  | { action: "stopSearch"; queues?: string[] }
  | { action: "joinGame"; gameId: number; password?: string }
  | { action: "refresh" };

/** "1 vs 1", as the Rust client names a queue. Two 4v4 queues tell themselves apart. */
export function queueTitle(queue: Pick<PcQueue, "name" | "teamSize">): string {
  const base = `${queue.teamSize} vs ${queue.teamSize}`;
  if (/share_until_death/i.test(queue.name)) return `${base}, no share`;
  if (/full_share/i.test(queue.name)) return `${base}, full share`;
  return base;
}

/** A queue by its technical name, for status lines. */
export function queueName(name: string, queues: PcQueue[]): string {
  const known = queues.find((q) => q.name === name);
  if (known) return queueTitle(known);
  const size = /(\d)v\1/.exec(name);
  return size ? `${size[1]} vs ${size[1]}` : name;
}
