// Who the people in the chat are: their avatar and clan tag, read from FAF's
// API by name, a batch at a time, for the people who are online.
//
// The desktop clients get this from the lobby server's player list, which also
// carries the country and the friends list. This site has no lobby connection,
// so it asks the API instead, which has the avatar and the clan but neither the
// country nor friends (those live in faf-player-service and only reach a lobby
// session).

import { ApiError, fafPath, getJson, pick, related, type JsonApiDocument, type JsonApiResource } from "../api";

export interface Profile {
  id: string;
  clan: string | null;
  avatarUrl: string | null;
  avatarTooltip: string | null;
}

/** Names per request: an `in` list of logins, so the URL stays short. */
const BATCH = 50;
const FLUSH_DELAY_MS = 250;

const keyOf = (name: string) => name.toLowerCase();

/** RSQL quoting: nothing in a login needs escaping, but nothing may break out either. */
const quoted = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

function avatarOf(doc: JsonApiDocument, player: JsonApiResource): JsonApiResource | undefined {
  // The selected avatar, where the API has it as its own relationship...
  if (player.relationships && "currentAvatar" in player.relationships) return related(doc, player, "currentAvatar");
  // ...and otherwise the assignment marked selected, as the desktop clients read it.
  const refs = player.relationships?.avatarAssignments?.data;
  for (const ref of Array.isArray(refs) ? refs : []) {
    const assignment = doc.included?.find((item) => item.type === ref.type && item.id === ref.id);
    if (assignment && pick<boolean>(assignment.attributes, "selected")) return related(doc, assignment, "avatar");
  }
  return undefined;
}

function profileOf(doc: JsonApiDocument, player: JsonApiResource): Profile {
  const avatar = avatarOf(doc, player);
  const membership = related(doc, player, "clanMembership");
  const clan = membership ? related(doc, membership, "clan") : undefined;
  const url = pick<string>(avatar?.attributes, "url");
  return {
    id: player.id,
    clan: pick<string>(clan?.attributes, "tag") ?? null,
    avatarUrl: url && /^https:\/\//.test(url) ? url : null,
    avatarTooltip: pick<string>(avatar?.attributes, "tooltip") ?? null,
  };
}

class Profiles {
  version = 0;
  /** login key -> profile, or null when the API has no such player or could not say. */
  private known = new Map<string, Profile | null>();
  private queue: string[] = [];
  private queued = new Set<string>();
  private timer = 0;
  private running = false;
  private listeners = new Set<() => void>();
  /** Whether the API knows the newer `currentAvatar` relationship; found out on the first request. */
  private currentAvatar = true;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  get(name: string): Profile | null | undefined {
    return this.known.get(keyOf(name));
  }

  /** Ask for whoever of these is not known yet. Cheap to call on every render. */
  want(names: Iterable<string>) {
    let added = false;
    for (const name of names) {
      const key = keyOf(name);
      if (this.known.has(key) || this.queued.has(key)) continue;
      this.queued.add(key);
      this.queue.push(name);
      added = true;
    }
    if (added && !this.timer && !this.running) this.timer = window.setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
  }

  private async flush() {
    this.timer = 0;
    this.running = true;
    try {
      while (this.queue.length) {
        const names = this.queue.splice(0, BATCH);
        let doc: JsonApiDocument | null = null;
        try {
          doc = await this.fetch(names);
        } catch {
          doc = null;
        }
        const found = new Set<string>();
        for (const player of doc?.data ?? []) {
          const login = pick<string>(player.attributes, "login");
          if (!login) continue;
          found.add(keyOf(login));
          this.known.set(keyOf(login), profileOf(doc!, player));
        }
        // Not found, or the API could not answer: asked once per page load.
        for (const name of names) {
          if (!found.has(keyOf(name))) this.known.set(keyOf(name), null);
          this.queued.delete(keyOf(name));
        }
        this.version++;
        this.listeners.forEach((listener) => listener());
      }
    } finally {
      this.running = false;
    }
  }

  private async fetch(names: string[]): Promise<JsonApiDocument> {
    const query = (include: string) =>
      fafPath("player", {
        filter: `login=in=(${names.map(quoted).join(",")})`,
        include,
        "page[size]": String(names.length),
      });
    if (this.currentAvatar) {
      try {
        return await getJson<JsonApiDocument>(query("currentAvatar,clanMembership.clan"));
      } catch (error) {
        // An API from before `currentAvatar` refuses the include: use the assignments from then on.
        if (!(error instanceof ApiError && error.status === 400)) throw error;
        this.currentAvatar = false;
      }
    }
    return getJson<JsonApiDocument>(query("avatarAssignments.avatar,clanMembership.clan"));
  }
}

export const profiles = new Profiles();
