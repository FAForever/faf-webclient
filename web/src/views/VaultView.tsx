import { useEffect, useState } from "react";
import { fafPath, formatDate, pick, related, type JsonApiDocument, type JsonApiResource } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { VaultDetail } from "../vault/VaultDetail";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

const PAGE_SIZE = 40;

type Kind = "map" | "mod";

/**
 * A map preview or mod logo, or the vault's icon in its place when there is
 * none or it fails to load: about half the mod vault ships no art. Mod logos
 * are shown whole; map previews fill the square. As the Rust client does
 * (ui/src/features/mods/ModVaultComponents.tsx, ModIcon).
 */
function VaultThumb({ url, kind }: { url?: string; kind: Kind }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) {
    return (
      <div className="web-vault-thumb is-placeholder" aria-hidden="true">
        <Icon name={kind === "map" ? "maps" : "mods"} size={40} />
      </div>
    );
  }
  return (
    <img
      className={`web-vault-thumb${kind === "mod" ? " is-logo" : ""}`}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// ---- the query, as the Rust client builds it (faf-domain protocol/vault_query.rs)

const SORTS: Record<Kind, { id: string; label: string; param: string }[]> = {
  map: [
    { id: "rating", label: "Best rated", param: "-reviewsSummary.lowerBound" },
    { id: "played", label: "Most played", param: "-gamesPlayed" },
    { id: "newest", label: "Newest", param: "-latestVersion.createTime" },
    { id: "name", label: "Name", param: "displayName" },
    { id: "size", label: "Largest", param: "-latestVersion.width" },
  ],
  mod: [
    { id: "rating", label: "Best rated", param: "-reviewsSummary.lowerBound" },
    { id: "newest", label: "Newest", param: "-latestVersion.createTime" },
    { id: "updated", label: "Recently updated", param: "-latestVersion.updateTime" },
    { id: "name", label: "Name", param: "displayName" },
  ],
};

// Map width in game units: 256 is a 5 km map.
const SIZES = [
  { value: "256", label: "5 km" },
  { value: "512", label: "10 km" },
  { value: "1024", label: "20 km" },
  { value: "2048", label: "40 km" },
  { value: "4096", label: "81 km" },
];

const PLAYERS = ["2", "4", "6", "8", "10", "12", "16"];

// Same includes as the Rust client (infra/maps.rs, infra/mods.rs).
const INCLUDE: Record<Kind, string> = {
  map: "latestVersion,author,reviewsSummary",
  mod: "latestVersion,uploader,reviewsSummary",
};

interface Filters {
  search: string;
  author: string;
  sort: string;
  players: string;
  size: string;
  ranked: string;
  type: string;
}

const EMPTY: Filters = { search: "", author: "", sort: "rating", players: "", size: "", ranked: "", type: "" };

/** Text for an RSQL glob: quotes, wildcards and backslashes out. */
const glob = (text: string) => `*${text.replace(/["*\\]/g, "")}*`;

function queryFor(kind: Kind, f: Filters, page: number): Record<string, string> {
  const clauses: string[] = [];
  // Hidden is how maps and mods are taken out of the vault (by their author or
  // by moderation): never shown, for both kinds, as in the Rust client.
  clauses.push("latestVersion.hidden=='false'");
  // Every word has to appear somewhere in the name, in any order.
  for (const word of f.search.split(/\s+/).filter((w) => w.replace(/["*\\]/g, ""))) {
    clauses.push(`displayName=="${glob(word)}"`);
  }
  if (f.author.trim()) {
    const pattern = glob(f.author.trim());
    clauses.push(kind === "map" ? `author.login=="${pattern}"` : `(author=="${pattern}",uploader.login=="${pattern}")`);
  }
  if (f.ranked) clauses.push(`latestVersion.ranked=="${f.ranked === "ranked"}"`);
  if (kind === "map" && f.players) clauses.push(`latestVersion.maxPlayers=="${f.players}"`);
  if (kind === "map" && f.size) clauses.push(`latestVersion.width=="${f.size}"`);
  if (kind === "mod" && f.type) clauses.push(`latestVersion.type=="${f.type}"`);

  const sort = SORTS[kind].find((s) => s.id === f.sort) ?? SORTS[kind][0];
  const params: Record<string, string> = {
    include: INCLUDE[kind],
    sort: sort.param,
    "page[size]": String(PAGE_SIZE),
    "page[number]": String(page),
  };
  if (clauses.length) params.filter = clauses.join(";");
  return params;
}

// ---- one card

function rating(doc: JsonApiDocument, item: JsonApiResource): string | null {
  const summary = related(doc, item, "reviewsSummary")?.attributes;
  const reviews = pick<number>(summary, "reviews");
  const score = pick<number>(summary, "averageScore");
  if (!reviews || typeof score !== "number") return null;
  return `${score.toFixed(1)} (${reviews})`;
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** One map or mod. The whole card opens its details (vault/VaultDetail.tsx). */
function VaultCard({ doc, item, kind, onOpen }: { doc: JsonApiDocument; item: JsonApiResource; kind: Kind; onOpen: () => void }) {
  const a = item.attributes ?? {};
  const version = related(doc, item, "latestVersion");
  const v = version?.attributes ?? {};
  const thumb = pick<string>(v, "thumbnailUrlSmall", "thumbnailUrl", "thumbnailUrlLarge");
  const author =
    kind === "map"
      ? pick<string>(related(doc, item, "author")?.attributes, "login")
      : pick<string>(a, "author") ?? pick<string>(related(doc, item, "uploader")?.attributes, "login");
  const stars = rating(doc, item);
  const width = pick<number>(v, "width");
  const players = pick<number>(v, "maxPlayers");
  const played = pick<number>(a, "gamesPlayed");
  const type = pick<string>(v, "type");
  const ranked = pick<boolean>(v, "ranked");
  const name = pick<string>(a, "displayName", "name") ?? "-";

  return (
    <article className="web-card web-vault-card">
      <button type="button" className="web-vault-open" onClick={onOpen} aria-label={`${name}: details`}>
        <VaultThumb url={thumb} kind={kind} />
        <div className="web-vault-body">
          <h2 className="web-card-title">{name}</h2>
          <p className="muted">{author ? `by ${author}` : "Author unknown"}</p>
          <div className="web-chips">
            {stars && (
              <span className="web-chip" title="Average review score, out of 5 (reviews)">
                <Icon name="star" size={12} /> {stars}
              </span>
            )}
            {players != null && (
              <span className="web-chip" title="Players">
                <Icon name="users" size={13} /> {players}
              </span>
            )}
            {width != null && <span className="web-chip">{Math.round(width / 51.2)} km</span>}
            {kind === "map" && typeof played === "number" && played > 0 && (
              <span className="web-chip" title={`${played} games played`}>
                <Icon name="play" size={12} /> {compact(played)}
              </span>
            )}
            {type && <span className="web-chip">{type === "SIM" ? "Sim mod" : type === "UI" ? "UI mod" : type}</span>}
            {ranked === false && <span className="web-chip">Unranked</span>}
            <span className="web-chip">{formatDate(pick(v, "updateTime", "createTime"))}</span>
          </div>
        </div>
      </button>
    </article>
  );
}

// ---- the tab

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="web-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function VaultView({ kind }: { kind: Kind }) {
  const noun = kind === "map" ? "maps" : "mods";
  const [typed, setTyped] = useState({ search: "", author: "" });
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  // The card's document goes with it: the list may page on underneath.
  const [open, setOpen] = useState<{ doc: JsonApiDocument; item: JsonApiResource } | null>(null);

  // Text fields search after a short pause in typing, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.search === typed.search.trim() && f.author === typed.author.trim() ? f : { ...f, search: typed.search.trim(), author: typed.author.trim() }));
      setPage(1);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const set = (key: keyof Filters) => (value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const load = useJson<JsonApiDocument>(fafPath(kind, queryFor(kind, filters, page)));
  const items = load.state === "ready" ? load.data.data ?? [] : [];
  const narrowed = Boolean(filters.search || filters.author || filters.players || filters.size || filters.ranked || filters.type);

  return (
    <div className="web-view">
      <ViewHeader
        title={kind === "map" ? "Maps" : "Mods"}
        description={`Browse the FAF ${noun} vault. Installing needs the desktop client.`}
      />
      <div className="web-filters">
        <label className="web-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder={`Search ${noun}`}
            aria-label={`Search ${noun} by name`}
            value={typed.search}
            onChange={(event) => setTyped((t) => ({ ...t, search: event.target.value }))}
          />
        </label>
        <label className="web-search">
          <Icon name="user" size={16} />
          <input
            type="search"
            placeholder="Author"
            aria-label="Author"
            value={typed.author}
            onChange={(event) => setTyped((t) => ({ ...t, author: event.target.value }))}
          />
        </label>
        <div className="web-filter-row">
          <Select label="Sort" value={filters.sort} onChange={set("sort")} options={SORTS[kind].map((s) => ({ value: s.id, label: s.label }))} />
          {kind === "map" && (
            <>
              <Select
                label="Players"
                value={filters.players}
                onChange={set("players")}
                options={[{ value: "", label: "Any" }, ...PLAYERS.map((p) => ({ value: p, label: p }))]}
              />
              <Select label="Size" value={filters.size} onChange={set("size")} options={[{ value: "", label: "Any" }, ...SIZES]} />
            </>
          )}
          {kind === "mod" && (
            <Select
              label="Type"
              value={filters.type}
              onChange={set("type")}
              options={[
                { value: "", label: "Any" },
                { value: "SIM", label: "Sim mods" },
                { value: "UI", label: "UI mods" },
              ]}
            />
          )}
          <Select
            label="Ranked"
            value={filters.ranked}
            onChange={set("ranked")}
            options={[
              { value: "", label: "Any" },
              { value: "ranked", label: "Ranked" },
              { value: "unranked", label: "Unranked" },
            ]}
          />
          {narrowed && (
            <button
              type="button"
              className="web-button"
              onClick={() => {
                setTyped({ search: "", author: "" });
                setFilters((f) => ({ ...EMPTY, sort: f.sort }));
                setPage(1);
              }}
            >
              <Icon name="close" size={13} /> Clear
            </button>
          )}
        </div>
      </div>

      {load.state === "loading" && <Loading what={`the ${noun} vault`} />}
      {load.state === "error" && (
        <LoadFailed icon={kind === "map" ? "maps" : "mods"} what={`the ${noun} vault`} status={load.status} code={load.code} />
      )}
      {load.state === "ready" &&
        (items.length === 0 ? (
          <EmptyState icon="search" title={`No ${noun} found`} hint="Try a different search or fewer filters." bordered />
        ) : (
          <>
            <div className="web-grid web-grid-vault">
              {items.map((item) => (
                <VaultCard key={item.id} doc={load.data} item={item} kind={kind} onOpen={() => setOpen({ doc: load.data, item })} />
              ))}
            </div>
            <div className="web-pager">
              <button className="web-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted">Page {page}</span>
              <button className="web-button" disabled={items.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)}>
                Next
              </button>
            </div>
          </>
        ))}
      {open && <VaultDetail kind={kind} doc={open.doc} item={open.item} onClose={() => setOpen(null)} />}
    </div>
  );
}
