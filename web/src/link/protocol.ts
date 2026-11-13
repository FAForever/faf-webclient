// The PC link: what the FAF Rust client on the player's PC sends through this
// site (lib/link.js), and what the page may ask it to do.
//
// The shapes are the Rust client's (crates/faf-domain/src/protocol/web_link.rs
// in its repository, and docs/web-link-protocol.json there, which the server's
// tests check against): it builds them from its own state, this site only
// passes them on. Version 1.

export const LINK_VERSION = 1;

/** The PC as the server describes it to a browser. */
export interface PcInfo {
  connected: boolean;
  /** "FAF Rust client 1.4.0", say. Nothing about the computer itself is sent. */
  client?: string;
  /** The FAF account it is logged in as. */
  name?: string;
}

export type MatchmakingStatus = "idle" | "preparing" | "searching" | "matchFound" | "launching" | "cancelled";

export interface PcQueue {
  /** Technical name, as the commands take it: "ladder1v1", "tmm2v2", ... */
  name: string;
  /** "1 vs 1", as the client on the PC names it. */
  title: string;
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
  /** The game this PC is joining or playing, if any; or a join that stopped short. */
  game: PcCurrentGame | null;
  /** Everyone on the friends list, online first. */
  friends: PcFriend[];
}

export interface PcCurrentGame {
  id: number | null;
  title: string;
  /** "needsYou": stopped at a decision only the player at the PC can make. */
  status: "joining" | "preparing" | "launched" | "lobby" | "playing" | "needsYou" | "failed";
  /** For "needsYou" and "failed": what happened, in a sentence. */
  problem: string | null;
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

/**
 * A queue as the client on the PC titles it ("1 vs 1"). Two queues of the same
 * size (the 4v4s) would read the same, so only then they tell themselves apart.
 */
export function queueTitle(queue: Pick<PcQueue, "name" | "teamSize" | "title">, queues: PcQueue[] = []): string {
  const base = queue.title || `${queue.teamSize} vs ${queue.teamSize}`;
  const twin = queues.some((other) => other.name !== queue.name && (other.title || `${other.teamSize} vs ${other.teamSize}`) === base);
  if (!twin) return base;
  if (/share_until_death/i.test(queue.name)) return `${base}, no share`;
  if (/full_share/i.test(queue.name)) return `${base}, full share`;
  return base;
}

/** A queue by its technical name, for status lines. */
export function queueName(name: string, queues: PcQueue[]): string {
  const known = queues.find((q) => q.name === name);
  return known ? queueTitle(known, queues) : name;
}
