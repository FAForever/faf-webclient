// The Changelog tab, after the Rust client's (ui/src/features/changelog):
// the dated releases by year beside one reading surface for the open note,
// with unit icons and balance changes drawn as old -> new. On a phone the list
// and the note are two pages, /changelog and /changelog/<patch>.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { LoadFailed, useMedia, useText } from "../views/common";
import {
  notePath,
  parseIndex,
  parseNote,
  parseSpans,
  releaseWebUrl,
  unitIconUrl,
  type Block,
  type ListItem,
  type Release,
  type Span,
} from "./parse";
import "./changelog.css";

const INDEX_PATH = "/api/changelog/changelog";

function idFromPath(): string | null {
  const m = /^\/changelog\/(\d{3,5})\/?$/.exec(window.location.pathname);
  return m ? m[1] : null;
}

const isPatch = (r: Release) => /patch/i.test(r.kind);

function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

// parseSpans, memoised: change lines repeat a lot ("BuildTime", "Health").
const spanCache = new Map<string, Span[]>();
function parseSpansCached(text: string): Span[] {
  let spans = spanCache.get(text);
  if (!spans) {
    spans = parseSpans(text);
    if (spanCache.size > 2000) spanCache.clear();
    spanCache.set(text, spans);
  }
  return spans;
}

// ---- the note's pieces

function UnitIcon({ id, size }: { id: string; size: number }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    <img
      className="changelog-unit-icon"
      src={unitIconUrl(id)}
      alt=""
      title={id}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      decoding="async"
      onError={() => setMissing(true)}
    />
  );
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.type) {
          case "strong":
            return <strong key={i}>{span.text}</strong>;
          case "code":
            return (
              <code key={i} className="changelog-code">
                {span.text}
              </code>
            );
          case "link":
            return (
              <a key={i} className="changelog-link" href={span.url} target="_blank" rel="noopener noreferrer">
                {span.text}
              </a>
            );
          case "issue":
            return (
              <a key={i} className="changelog-issue" href={span.url} target="_blank" rel="noopener noreferrer" title={`Pull request or issue #${span.number}`}>
                #{span.number}
              </a>
            );
          default:
            return <Fragment key={i}>{span.text}</Fragment>;
        }
      })}
    </>
  );
}

/** A piece of a change line, which can still carry `code` or **bold**. */
const Inline = ({ text }: { text: string }) => <Spans spans={parseSpansCached(text)} />;

function Item({ item }: { item: ListItem }) {
  let body: ReactNode;
  if (item.change) {
    body = (
      <span className="changelog-change">
        <span className="changelog-change-label">
          <Inline text={item.change.label} />
        </span>
        <span className="changelog-old">
          <Inline text={item.change.old} />
        </span>
        <Icon name="arrowRight" size={12} aria-hidden="true" />
        <span className="changelog-new">
          <Inline text={item.change.new} />
        </span>
      </span>
    );
  } else if (item.unit) {
    body = (
      <span className="changelog-item-unit">
        <span className="changelog-unit-icons">
          {item.unit.ids.map((id) => (
            <UnitIcon key={id} id={id} size={28} />
          ))}
        </span>
        <strong>{item.unit.name}</strong>
      </span>
    );
  } else {
    body = <Spans spans={item.spans} />;
  }
  return (
    <li className={item.change ? "is-change" : undefined}>
      {body}
      {item.children.length > 0 && (
        <ul className="changelog-list">
          {item.children.map((child, i) => (
            <Item key={i} item={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

const headingId = (index: number) => `changelog-section-${index}`;

function BlockView({ block, index }: { block: Block; index: number }) {
  switch (block.type) {
    case "heading": {
      // The note's title is the page's one h1; its sections start at h2.
      const level = Math.min(Math.max(block.level, 2), 6);
      const Tag = `h${level}` as "h2";
      return (
        <Tag id={headingId(index)} className={`changelog-heading changelog-heading-${level}`}>
          <Spans spans={parseSpansCached(block.text)} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="changelog-paragraph">
          <Spans spans={block.spans} />
        </p>
      );
    case "unit":
      return (
        <div className="changelog-unit">
          <span className="changelog-unit-icons">
            {block.ids.map((id) => (
              <UnitIcon key={id} id={id} size={48} />
            ))}
          </span>
          <span className="changelog-unit-name">{block.name || block.ids.join(", ")}</span>
        </div>
      );
    case "list":
      return (
        <ul className="changelog-list">
          {block.items.map((item, i) => (
            <Item key={i} item={item} />
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="changelog-code-block">
          <code>{block.text}</code>
        </pre>
      );
  }
}

// ---- one note

function Note({
  release,
  newer,
  older,
  onPick,
  onBack,
}: {
  release: Release;
  newer: Release | null;
  older: Release | null;
  onPick: (r: Release) => void;
  onBack?: () => void;
}) {
  const load = useText(notePath(release));
  const scroller = useRef<HTMLDivElement>(null);
  const note = useMemo(() => (load.state === "ready" ? parseNote(release.id, load.data) : null), [load, release.id]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [release.id]);

  // Sections to jump to: the note's top level of headings under its title
  // (a leading "# Game version 3837" is the title again, not a section).
  const headings = (note?.blocks ?? [])
    .map((block, index) => ({ block, index }))
    .filter((s): s is { block: Extract<Block, { type: "heading" }>; index: number } => s.block.type === "heading");
  const top = Math.min(...headings.filter((h) => h.block.level > 1).map((h) => h.block.level));
  const sections = headings.filter((h) => h.block.level === top);

  return (
    <article className="changelog-note surface-panel">
      <header className="changelog-note-head">
        <div className="changelog-note-heading">
          {onBack && (
            <button type="button" className="changelog-back" onClick={onBack}>
              <Icon name="arrowLeft" size={14} /> All patches
            </button>
          )}
          <h1>
            {release.kind} {release.id}
          </h1>
          <p className="changelog-note-meta">
            <span className={isPatch(release) ? "changelog-kind-tag is-patch" : "changelog-kind-tag"}>{release.kind}</span>
            <span>{longDate(release.date)}</span>
          </p>
        </div>
        <div className="changelog-note-actions">
          <div className="changelog-step" role="group" aria-label="Newer or older patch">
            <button type="button" className="changelog-step-btn" disabled={!newer} onClick={() => newer && onPick(newer)} title={newer ? `Newer: ${newer.id}` : "Newest"} aria-label="Newer patch">
              <Icon name="chevronUp" size={15} />
            </button>
            <button type="button" className="changelog-step-btn" disabled={!older} onClick={() => older && onPick(older)} title={older ? `Older: ${older.id}` : "Oldest"} aria-label="Older patch">
              <Icon name="chevronDown" size={15} />
            </button>
          </div>
          <a className="web-button changelog-external" href={releaseWebUrl(release.id)} target="_blank" rel="noopener noreferrer" title="Open on the website">
            <Icon name="external" size={13} />
            <span>Website</span>
          </a>
        </div>
      </header>

      <div className="changelog-note-scroll" ref={scroller}>
        <div className="changelog-note-copy">
          {load.state === "loading" && <p className="muted">Loading patch notes...</p>}
          {load.state === "error" && (
            <EmptyState
              icon="changelog"
              title="These patch notes couldn't be loaded"
              hint={load.status ? `The server answered ${load.status}. They are also on the website.` : "Check your connection and try again."}
            />
          )}
          {note && (
            <>
              {sections.length > 1 && (
                <nav className="changelog-jump" aria-label="On this page">
                  {sections.map((s) => (
                    <button
                      key={s.index}
                      type="button"
                      className="changelog-jump-item"
                      onClick={() => document.getElementById(headingId(s.index))?.scrollIntoView({ block: "start" })}
                    >
                      {s.block.text.replace(/\*\*|`/g, "")}
                    </button>
                  ))}
                </nav>
              )}
              {note.blocks.map((block, index) => (
                <BlockView key={index} block={block} index={index} />
              ))}
              {note.blocks.length === 0 && <p className="muted">This note is empty.</p>}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// ---- the list

function ReleaseList({ releases, current, onPick }: { releases: Release[]; current: string | null; onPick: (r: Release) => void }) {
  const [text, setText] = useState("");
  const years = useMemo(() => [...new Set(releases.map((r) => r.year))], [releases]);
  const currentYear = releases.find((r) => r.id === current)?.year;
  const [open, setOpen] = useState<Set<string>>(() => new Set([years[0], currentYear].filter(Boolean) as string[]));

  useEffect(() => {
    if (currentYear) setOpen((o) => (o.has(currentYear) ? o : new Set([...o, currentYear])));
  }, [currentYear]);

  // A note opened from a link or the step buttons is shown in the list too.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!current) return;
    const frame = window.requestAnimationFrame(() =>
      list.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [current]);

  const query = text.trim().toLowerCase();
  const shown = query ? releases.filter((r) => `${r.id} ${r.kind} ${r.date} ${shortDate(r.date)}`.toLowerCase().includes(query)) : releases;

  return (
    <nav className="changelog-sidebar surface-panel" aria-label="Releases">
      <label className="web-search changelog-search">
        <Icon name="search" size={15} />
        <input type="search" placeholder="Search patches" aria-label="Search game patches" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="changelog-releases" ref={list}>
        {shown.length === 0 && <p className="changelog-list-note">No patch matches that.</p>}
        {years.map((year) => {
          const inYear = shown.filter((r) => r.year === year);
          if (inYear.length === 0) return null;
          const expanded = query !== "" || open.has(year);
          return (
            <section key={year} className="changelog-year">
              <button
                type="button"
                className="changelog-year-toggle"
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((o) => {
                    const next = new Set(o);
                    if (next.has(year)) next.delete(year);
                    else next.add(year);
                    return next;
                  })
                }
              >
                <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
                {year}
                <span className="changelog-year-count">{inYear.length}</span>
              </button>
              <ul className="changelog-year-releases" hidden={!expanded}>
                {inYear.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={isPatch(r) ? "changelog-release is-patch" : "changelog-release"}
                      aria-current={r.id === current ? "page" : undefined}
                      onClick={() => onPick(r)}
                    >
                      <span className="changelog-release-id">{r.id}</span>
                      <span className="changelog-release-kind">{r.kind}</span>
                      <span className="changelog-release-date">{shortDate(r.date)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}

// ---- the tab

export function ChangelogView() {
  const load = useText(INDEX_PATH, 600_000);
  const releases = useMemo(() => (load.state === "ready" ? parseIndex(load.data) : []), [load]);
  const [id, setId] = useState(idFromPath);
  const narrow = useMedia("(max-width: 900px)");

  useEffect(() => {
    const onPop = () => setId(idFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pick = (release: Release) => {
    if (release.id !== idFromPath()) window.history.pushState(null, "", `/changelog/${release.id}`);
    setId(release.id);
    if (narrow) document.querySelector(".content")?.scrollTo({ top: 0 });
  };

  const back = () => {
    window.history.pushState(null, "", "/changelog");
    setId(null);
  };

  // With room for both, the newest note is open from the start.
  const index = id ? releases.findIndex((r) => r.id === id) : narrow ? -1 : 0;
  const release = index >= 0 ? releases[index] : null;
  const unknown = id !== null && load.state === "ready" && !release;

  let body: ReactNode;
  if (load.state === "loading") body = <p className="muted">Loading patches...</p>;
  else if (load.state === "error") body = <LoadFailed icon="changelog" what="the changelog" status={load.status} code={load.code} />;
  else if (releases.length === 0) body = <EmptyState icon="changelog" title="No patches found" bordered />;
  else {
    const note = release ? (
      <Note
        release={release}
        newer={index > 0 ? releases[index - 1] : null}
        older={index < releases.length - 1 ? releases[index + 1] : null}
        onPick={pick}
        onBack={narrow ? back : undefined}
      />
    ) : unknown ? (
      <EmptyState icon="changelog" title={`No patch ${id}`} hint="Pick one from the list." bordered />
    ) : null;
    body = narrow ? (
      release ? (
        note
      ) : (
        <>
          {note}
          <ReleaseList releases={releases} current={null} onPick={pick} />
        </>
      )
    ) : (
      <div className="changelog-view">
        <ReleaseList releases={releases} current={release?.id ?? null} onPick={pick} />
        {note ?? <EmptyState icon="changelog" title="Pick a patch to read its notes" bordered />}
      </div>
    );
  }

  return (
    <div className="web-view web-view-changelog">
      {!(narrow && release) && (
        <header className="web-view-header">
          <div>
            <h1>Changelog</h1>
            <p className="muted">Game patch notes, from FAForever/fa.</p>
          </div>
        </header>
      )}
      {body}
    </div>
  );
}
