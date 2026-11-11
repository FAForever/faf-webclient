import { useEffect, useState } from "react";
import { fafPath, formatDate, pick, related, type JsonApiDocument } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { LoadFailed, Loading, useJson, ViewHeader } from "./common";

const PAGE_SIZE = 40;

export function VaultView({ kind }: { kind: "map" | "mod" }) {
  const noun = kind === "map" ? "maps" : "mods";
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Search after a short pause in typing, not on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(typed.trim());
      setPage(1);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [typed]);

  // Same queries the Rust client sends (crates/faf-app/src/infra/maps.rs, mods.rs).
  const params: Record<string, string> = {
    include: "latestVersion",
    sort: kind === "map" ? "-createTime" : "-latestVersion.createTime",
    "page[size]": String(PAGE_SIZE),
    "page[number]": String(page),
  };
  const filters = kind === "map" ? ["latestVersion.hidden=='false'"] : [];
  if (search) filters.push(`displayName=="*${search.replace(/["*\\]/g, "")}*"`);
  if (filters.length) params.filter = filters.join(";");
  const load = useJson<JsonApiDocument>(fafPath(kind, params));

  return (
    <div className="web-view">
      <ViewHeader
        title={kind === "map" ? "Maps" : "Mods"}
        description={`Browse the FAF ${noun} vault. Installing needs the desktop client.`}
      />
      <label className="web-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          placeholder={`Search ${noun}`}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>

      {load.state === "loading" && <Loading what={`the ${noun} vault`} />}
      {load.state === "error" && (
        <LoadFailed icon={kind === "map" ? "maps" : "mods"} what={`the ${noun} vault`} status={load.status} code={load.code} />
      )}
      {load.state === "ready" &&
        ((load.data.data ?? []).length === 0 ? (
          <EmptyState icon="search" title={`No ${noun} found`} hint="Try a different search." bordered />
        ) : (
          <>
            <div className="web-grid web-grid-vault">
              {(load.data.data ?? []).map((item) => {
                const a = item.attributes ?? {};
                const version = related(load.data, item, "latestVersion");
                const v = version?.attributes ?? {};
                const thumb = pick<string>(v, "thumbnailUrlSmall", "thumbnailUrl", "thumbnailUrlLarge");
                const width = pick<number>(v, "width");
                const players = pick<number>(v, "maxPlayers");
                return (
                  <article key={item.id} className="web-card web-vault-card">
                    {thumb ? (
                      <img className="web-vault-thumb" src={thumb} alt="" loading="lazy" />
                    ) : (
                      <div className="web-vault-thumb is-missing" />
                    )}
                    <div className="web-vault-body">
                      <h2 className="web-card-title">{pick<string>(a, "displayName", "name") ?? "-"}</h2>
                      <p className="muted">by {pick<string>(a, "author") ?? "unknown"}</p>
                      <div className="web-chips">
                        {players != null && (
                          <span className="web-chip">
                            <Icon name="users" size={13} /> {players}
                          </span>
                        )}
                        {width != null && <span className="web-chip">{Math.round(width / 51.2)} km</span>}
                        <span className="web-chip">{formatDate(pick(v, "updateTime", "createTime"))}</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="web-pager">
              <button className="web-button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </button>
              <span className="muted">Page {page}</span>
              <button
                className="web-button"
                disabled={(load.data.data ?? []).length < PAGE_SIZE}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </>
        ))}
    </div>
  );
}
