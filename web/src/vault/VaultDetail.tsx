// A map or a mod, opened from its vault card: the large preview, what it is,
// its description, its versions and what players said about it. After the
// Rust client's detail panels (ui/src/features/maps/MapVaultComponents.tsx
// MapDetailPanel, ui/src/features/mods/ModVaultComponents.tsx).
//
// What the card already had shows at once; versions and reviews are one more
// request, the one the Rust client makes for its reviews dialog
// (infra/reviews.rs: GET /data/{map|mod}/{id}/versions?include=reviews,reviews.player).

import { useEffect, useMemo, useRef, useState } from "react";
import { fafPath, formatDate, pick, related, type JsonApiDocument, type JsonApiResource } from "../api";
import { Icon } from "../ds/Icon";
import { go } from "../nav";
import { useJson, type Load } from "../views/common";
import "./vault.css";

export type VaultKind = "map" | "mod";

/** Map descriptions can open with a localisation tag the game reads and people should not. */
function cleanDescription(value: string | undefined): string {
  return (value ?? "").replace(/^<LOC\s+[^>]+>/i, "").replace(/\r\n/g, "\n").trim();
}

function sizeLabel(width: number | undefined, height: number | undefined): string | null {
  if (!width) return null;
  const km = (units: number) => Math.round(units / 51.2);
  return height && height !== width ? `${km(width)} x ${km(height)} km` : `${km(width)} km`;
}

function count(n: number): string {
  return n.toLocaleString();
}

function Stars({ score }: { score: number }) {
  const full = Math.round(score);
  return (
    <span className="vault-stars" aria-label={`${score} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon key={i} name="star" size={13} className={i <= full ? "is-on" : undefined} />
      ))}
    </span>
  );
}

interface Review {
  id: string;
  score: number;
  text: string;
  author: string;
  version: string;
  at: string | undefined;
}

/**
 * The versions still in the vault. A hidden version was taken out (by its
 * author or by moderation): it is not listed, not offered for download, and
 * its reviews are not shown.
 */
function visibleVersions(doc: JsonApiDocument): JsonApiResource[] {
  return (doc.data ?? []).filter((version) => pick<boolean>(version.attributes, "hidden") !== true);
}

function reviewsOf(doc: JsonApiDocument): Review[] {
  const out: Review[] = [];
  for (const version of visibleVersions(doc)) {
    const refs = version.relationships?.reviews?.data;
    const label = String(pick(version.attributes, "version") ?? "");
    for (const ref of Array.isArray(refs) ? refs : []) {
      const review = doc.included?.find((r) => r.type === ref.type && r.id === ref.id);
      if (!review) continue;
      const score = pick<number>(review.attributes, "score");
      if (typeof score !== "number") continue;
      out.push({
        id: review.id,
        score,
        text: String(pick(review.attributes, "text") ?? "").trim(),
        author: pick<string>(related(doc, review, "player")?.attributes, "login") ?? "",
        version: label,
        at: pick<string>(review.attributes, "updateTime", "createTime"),
      });
    }
  }
  return out.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

const REVIEWS_SHOWN = 10;

function Reviews({ load }: { load: Load<JsonApiDocument> }) {
  const [all, setAll] = useState(false);
  const reviews = useMemo(() => (load.state === "ready" ? reviewsOf(load.data) : []), [load]);
  if (load.state === "loading") return <p className="muted vault-note">Loading reviews...</p>;
  if (load.state === "error") return <p className="muted vault-note">The reviews could not be loaded.</p>;
  if (reviews.length === 0) return <p className="muted vault-note">No reviews yet. Reviews are written in the desktop client.</p>;
  const shown = all ? reviews : reviews.slice(0, REVIEWS_SHOWN);
  return (
    <>
      <ul className="vault-reviews">
        {shown.map((review) => (
          <li key={review.id} className="vault-review">
            <div className="vault-review-head">
              <Stars score={review.score} />
              <strong>{review.author || "Someone"}</strong>
              <span className="muted">
                {review.version ? `v${review.version}, ` : ""}
                {formatDate(review.at)}
              </span>
            </div>
            {review.text && <p>{review.text}</p>}
          </li>
        ))}
      </ul>
      {reviews.length > REVIEWS_SHOWN && (
        <button type="button" className="web-button vault-more" onClick={() => setAll((v) => !v)}>
          <Icon name={all ? "chevronUp" : "chevronDown"} size={14} />
          {all ? "Fewer reviews" : `All ${reviews.length} reviews`}
        </button>
      )}
    </>
  );
}

function Versions({ load }: { load: Load<JsonApiDocument> }) {
  const [all, setAll] = useState(false);
  if (load.state !== "ready") return null;
  const versions = visibleVersions(load.data).sort((a, b) =>
    String(pick(b.attributes, "createTime") ?? "").localeCompare(String(pick(a.attributes, "createTime") ?? "")),
  );
  if (versions.length === 0) return null;
  const shown = all ? versions : versions.slice(0, 5);
  return (
    <section className="vault-section">
      <h3 className="vault-section-title">
        Versions <span className="muted">{versions.length}</span>
      </h3>
      <ul className="vault-versions">
        {shown.map((version) => {
          const a = version.attributes ?? {};
          const download = pick<string>(a, "downloadUrl");
          return (
            <li key={version.id}>
              <span className="vault-version-name">Version {String(pick(a, "version") ?? "?")}</span>
              <span className="muted">{formatDate(pick(a, "createTime"))}</span>
              {pick<boolean>(a, "ranked") === false && <span className="web-chip">Unranked</span>}
              {download && (
                <a className="vault-version-download" href={download} rel="noopener" title="Download this version">
                  <Icon name="download" size={14} />
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {versions.length > 5 && (
        <button type="button" className="web-button vault-more" onClick={() => setAll((v) => !v)}>
          <Icon name={all ? "chevronUp" : "chevronDown"} size={14} />
          {all ? "Fewer versions" : `All ${versions.length} versions`}
        </button>
      )}
    </section>
  );
}

export function VaultDetail({ kind, doc, item, onClose }: { kind: VaultKind; doc: JsonApiDocument; item: JsonApiResource; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const history = useJson<JsonApiDocument>(
    fafPath(`${kind}/${encodeURIComponent(item.id)}/versions`, { include: "reviews,reviews.player", "page[size]": "100" }),
  );

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const a = item.attributes ?? {};
  const version = related(doc, item, "latestVersion");
  const v = version?.attributes ?? {};
  const name = pick<string>(a, "displayName", "name") ?? "-";
  const author =
    kind === "map"
      ? pick<string>(related(doc, item, "author")?.attributes, "login")
      : pick<string>(a, "author") ?? pick<string>(related(doc, item, "uploader")?.attributes, "login");
  const uploader = kind === "mod" ? pick<string>(related(doc, item, "uploader")?.attributes, "login") : undefined;
  const summary = related(doc, item, "reviewsSummary")?.attributes;
  const reviews = pick<number>(summary, "reviews") ?? 0;
  const score = pick<number>(summary, "averageScore");
  const picture = kind === "map" ? pick<string>(v, "thumbnailUrlLarge", "thumbnailUrlSmall") : pick<string>(v, "thumbnailUrl");
  const [pictureFailed, setPictureFailed] = useState(false);
  const ranked = pick<boolean>(v, "ranked");
  const recommended = pick<boolean>(a, "recommended");
  const description = cleanDescription(pick<string>(v, "description"));
  const download = pick<string>(v, "downloadUrl");
  const type = pick<string>(v, "type");
  const played = pick<number>(a, "gamesPlayed");

  const facts: { label: string; value: string }[] = [];
  if (kind === "map") {
    const size = sizeLabel(pick<number>(v, "width"), pick<number>(v, "height"));
    if (size) facts.push({ label: "Size", value: size });
    const players = pick<number>(v, "maxPlayers");
    facts.push({ label: "Players", value: players ? String(players) : "-" });
  } else {
    facts.push({ label: "Type", value: type === "SIM" ? "Sim mod" : type === "UI" ? "UI mod" : type ?? "-" });
  }
  facts.push({ label: "Reviews", value: reviews > 0 && typeof score === "number" ? `${score.toFixed(1)} of 5 (${count(reviews)})` : "Not rated" });
  if (kind === "map" && typeof played === "number") facts.push({ label: "Games played", value: count(played) });
  facts.push({ label: "Version", value: pick(v, "version") != null ? String(pick(v, "version")) : "-" });
  facts.push({ label: kind === "map" ? "Uploaded" : "Published", value: formatDate(pick(v, "createTime")) });
  if (kind === "mod") facts.push({ label: "Updated", value: formatDate(pick(v, "updateTime", "createTime")) });

  return (
    <div className="web-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="web-dialog vault-detail" role="dialog" aria-modal="true" aria-labelledby="vault-detail-name">
        <div className="vault-detail-top">
          {picture && !pictureFailed ? (
            <a className={`vault-detail-picture${kind === "mod" ? " is-logo" : ""}`} href={picture} target="_blank" rel="noopener" title="Open the full picture">
              <img src={picture} alt="" onError={() => setPictureFailed(true)} />
            </a>
          ) : (
            <div className="vault-detail-picture is-placeholder" aria-hidden="true">
              <Icon name={kind === "map" ? "maps" : "mods"} size={48} />
            </div>
          )}
          <header className="vault-detail-head">
            <div className="vault-detail-name-row">
              <h2 id="vault-detail-name">{name}</h2>
              <button ref={closeRef} type="button" className="web-icon-button" aria-label="Close" onClick={onClose}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="muted">
              {author ? `by ${author}` : "Author unknown"}
              {uploader && uploader !== author ? `, uploaded by ${uploader}` : ""}
            </p>
            <div className="web-chips">
              {ranked !== undefined && <span className={`web-chip${ranked ? " is-open" : ""}`}>{ranked ? "Ranked" : "Unranked"}</span>}
              {recommended && (
                <span className="web-chip">
                  <Icon name="star" size={12} /> Featured
                </span>
              )}
              {kind === "map" && pick<string>(a, "mapType") && pick<string>(a, "mapType") !== "skirmish" && (
                <span className="web-chip">{pick<string>(a, "mapType")}</span>
              )}
            </div>
            <dl className="vault-facts">
              {facts.map((fact) => (
                <div key={fact.label}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          </header>
        </div>

        <section className="vault-section">
          <h3 className="vault-section-title">Description</h3>
          {description ? <p className="vault-description">{description}</p> : <p className="muted vault-note">No description.</p>}
        </section>

        <div className="vault-actions">
          {kind === "map" && (
            <button
              type="button"
              className="web-button"
              onClick={() => {
                onClose();
                go(`/replays?map=${encodeURIComponent(name)}`);
              }}
            >
              <Icon name="replays" size={15} /> Replays on this map
            </button>
          )}
          {download && (
            <a className="web-button" href={download} rel="noopener">
              <Icon name="download" size={15} /> Download
            </a>
          )}
          <span className="muted vault-note">Installing is done by the desktop client.</span>
        </div>

        <section className="vault-section">
          <h3 className="vault-section-title">
            Reviews {reviews > 0 && <span className="muted">{count(reviews)}</span>}
          </h3>
          <Reviews load={history} />
        </section>

        <Versions load={history} />

        {kind === "mod" && pick<string>(v, "uid") && <p className="muted vault-uid">UID {pick<string>(v, "uid")}</p>}
      </section>
    </div>
  );
}
