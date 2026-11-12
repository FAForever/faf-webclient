// FAF's game patch notes, read the way the Rust client reads them
// (crates/faf-domain/src/protocol/changelog.rs), trimmed to what this site
// shows: the dated releases, and each note's Markdown.
//
// The index is the page FAForever/fa's Jekyll site builds
// (faforever.github.io/fa/changelog). A dated note is the Markdown source of
// its post, docs/_posts/<YYYY-MM-DD>-<patch>.md. The Markdown is not general
// Markdown but what the repository's template and Liquid plugins produce:
// headings, paragraphs, nested dashed lists, `{% unit XRL0302 %}` blocks, and
// `Label: old -> new` value changes.

export interface Release {
  /** Game version, e.g. "3837". */
  id: string;
  /** "Game Patch", "Hotfix", ... */
  kind: string;
  /** YYYY-MM-DD */
  date: string;
  year: string;
}

export type Span =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; url: string }
  | { type: "issue"; number: string; url: string };

export interface Change {
  label: string;
  old: string;
  new: string;
}

export interface ListItem {
  spans: Span[];
  change: Change | null;
  /** An item that only names a unit, `Soul Ripper: Experimental Gunship (URA0401):`. */
  unit: { ids: string[]; name: string } | null;
  children: ListItem[];
}

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; spans: Span[] }
  | { type: "unit"; ids: string[]; name: string }
  | { type: "list"; items: ListItem[] }
  | { type: "code"; text: string };

export interface Note {
  id: string;
  title: string;
  blocks: Block[];
}

const ICON_BASE = "https://faforever.github.io/fa/assets/icons";
const ISSUE_BASE = "https://github.com/FAForever/fa/issues";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The site's icon for a unit (unit_block.rb): enhancements keep their path. */
export function unitIconUrl(id: string): string {
  return id.startsWith("enhancements") ? `${ICON_BASE}/${id}.png` : `${ICON_BASE}/${id.toUpperCase()}_icon.png`;
}

/** Where a release's note is read from, through this site's proxy. */
export function notePath(release: Release): string {
  return `/api/patchnote/${release.date}-${release.id}.md`;
}

export function releaseWebUrl(id: string): string {
  return `https://faforever.github.io/fa/changelog/${id}`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'");
}

/**
 * The dated releases on the index page, newest first. Driven by two markers:
 * `<h2 id="YYYY">` opens a year, and each `<a class="preview-title"
 * href="/fa/changelog/3837">3837 - Game Patch</a> <span>(Aug 14)</span>` is a
 * release. The rolling branch pages (fafbeta, fafdevelop) are left out.
 */
export function parseIndex(html: string): Release[] {
  const releases: Release[] = [];
  let year = "";
  const marker = /<h2 id="(\d{4})"|<a class="preview-title" href="\/fa\/changelog\/([^"]+)">([^<]*)<\/a>\s*<span>\(([A-Za-z]{3}) (\d{1,2})\)<\/span>/g;
  for (let m = marker.exec(html); m; m = marker.exec(html)) {
    if (m[1]) {
      year = m[1];
      continue;
    }
    const [, , slug, label, monthName, day] = m;
    if (!/^\d+$/.test(slug) || !year) continue;
    const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
    if (month < 1) continue;
    const text = decodeEntities(label.trim());
    releases.push({
      id: slug,
      kind: text.includes(" - ") ? text.split(" - ").slice(1).join(" - ").trim() : text,
      date: `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`,
      year,
    });
  }
  return releases;
}

// ---- one note

function splitFrontMatter(markdown: string): { front: string; body: string } {
  const text = markdown.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { front: "", body: text };
  const rest = text.slice(3).replace(/^[\r\n]+/, "");
  const end = rest.indexOf("\n---");
  if (end < 0) return { front: "", body: text };
  return { front: rest.slice(0, end), body: rest.slice(end + 4).replace(/^[\r\n-]+/, "") };
}

function frontValue(front: string, key: string): string | null {
  for (const line of front.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at).trim() === key) return line.slice(at + 1).trim().replace(/^"|"$/g, "");
  }
  return null;
}

/** Inline runs: **bold**, `code`, [text](url), and the (#7121) citations. */
export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|#(\d{3,6})\b/g;
  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) spans.push({ type: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ type: "strong", text: m[1] });
    else if (m[2] !== undefined) spans.push({ type: "code", text: m[2] });
    else if (m[3] !== undefined) {
      const url = m[4];
      if (/^https?:\/\//.test(url)) spans.push({ type: "link", text: m[3], url });
      else spans.push({ type: "text", text: m[3] });
    } else spans.push({ type: "issue", number: m[5], url: `${ISSUE_BASE}/${m[5]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ type: "text", text: text.slice(last) });
  return spans;
}

/** `Label: old -> new`, the substance of a balance patch. */
export function parseChange(text: string): Change | null {
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  const label = text.slice(0, colon).trim();
  const values = text.slice(colon + 1);
  for (const arrow of ["-->", "→", "->"]) {
    const at = values.indexOf(arrow);
    if (at < 0) continue;
    const old = values.slice(0, at).trim();
    const next = values.slice(at + arrow.length).trim();
    // A long label is a sentence that happens to hold an arrow, not a stat.
    if (!label || !old || !next || label.length > 80 || label.includes("](")) return null;
    return { label, old, new: next };
  }
  return null;
}

const UNIT_ID = /^[A-Za-z]{3}\d{4}$/;

/** The older prose header: `**Yathsou: T3 Submarine Hunter (XSS0304):**`. */
function proseUnit(text: string): Block | null {
  const inner = /^\*\*(.+)\*\*$/.exec(text.trim())?.[1]?.trim().replace(/:$/, "").trim();
  if (!inner) return null;
  const ids: string[] = [];
  const name = inner.replace(/\(([^)]*)\)/g, (whole, group: string) => {
    const parts = group.split(/\s*(?:,|&|\band\b)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length && parts.every((p) => UNIT_ID.test(p))) {
      for (const p of parts) if (!ids.includes(p.toUpperCase())) ids.push(p.toUpperCase());
      return "";
    }
    return whole;
  });
  if (!ids.length) return null;
  const clean = name.replace(/\s+/g, " ").trim().replace(/:$/, "").trim();
  return clean ? { type: "unit", ids, name: clean } : null;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isListMarker = (line: string) => /^\s*-(\s|$)/.test(line);

function headingLevel(trimmed: string): number {
  const hashes = /^#{1,6}/.exec(trimmed)?.[0].length ?? 0;
  if (!hashes) return 0;
  const next = trimmed[hashes];
  return next === undefined || next === " " || next === "\t" || /[A-Za-z]/.test(next) ? hashes : 0;
}

function unitOpen(trimmed: string): string | null {
  const m = /^\{%\s*unit\s+<?([^>%\s]+)>?\s*%\}$/.exec(trimmed);
  return m ? m[1] : null;
}

/** `Name (UEL0105, UEL0106)` at the end of a line that says nothing else. */
function namedUnit(text: string): { ids: string[]; name: string } | null {
  const m = /^(.*\S)\s*\(([A-Za-z]{3}\d{4}(?:\s*,\s*[A-Za-z]{3}\d{4})*)\):?$/.exec(text.trim().replace(/^\*\*|\*\*$/g, ""));
  if (!m || m[1].length > 90) return null;
  return { name: m[1].replace(/:$/, "").trim(), ids: m[2].split(",").map((id) => id.trim().toUpperCase()) };
}

function buildItem(text: string): ListItem {
  const change = parseChange(text);
  return { spans: parseSpans(text), change, unit: change ? null : namedUnit(text), children: [] };
}

function parseList(lines: string[]): ListItem[] {
  const roots: ListItem[] = [];
  const stack: { indent: number; item: ListItem }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isListMarker(line)) continue;
    const indent = indentOf(line);
    let text = line.trimStart().replace(/^-\s*/, "").trim();
    // Continuation lines of a wrapped item.
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !isListMarker(lines[i + 1]) &&
      indentOf(lines[i + 1]) >= indent + 2 &&
      !parseChange(text) &&
      !parseChange(lines[i + 1].trim())
    ) {
      text += " " + lines[++i].trim();
    }
    const item = buildItem(text);
    // Unmarked value changes indented under an item belong to it.
    while (i + 1 < lines.length && !isListMarker(lines[i + 1]) && indentOf(lines[i + 1]) >= indent + 2 && parseChange(lines[i + 1].trim())) {
      item.children.push(buildItem(lines[++i].trim()));
    }
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    if (stack.length) stack[stack.length - 1].item.children.push(item);
    else roots.push(item);
    stack.push({ indent, item });
  }
  return roots;
}

function parseBlocks(body: string): Block[] {
  const lines = body.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ");
    paragraph = [];
    blocks.push(proseUnit(text) ?? { type: "paragraph", spans: parseSpans(text) });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      i++;
      continue;
    }

    const fence = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const unit = unitOpen(trimmed);
    if (unit) {
      flush();
      const name: string[] = [];
      i++;
      while (i < lines.length && !/^\{%\s*endunit\s*%\}$/.test(lines[i].trim())) name.push(lines[i++].trim());
      i++;
      blocks.push({ type: "unit", ids: [unit], name: name.join(" ").trim() });
      continue;
    }

    const level = headingLevel(trimmed);
    if (level) {
      flush();
      blocks.push({ type: "heading", level, text: trimmed.slice(level).trim() });
      i++;
      continue;
    }

    if (isListMarker(line)) {
      flush();
      const asUnit = proseUnit(line.trimStart().replace(/^-\s*/, ""));
      if (asUnit) {
        blocks.push(asUnit);
        i++;
        continue;
      }
      const start = i;
      const base = indentOf(line);
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") {
          // A blank line ends the list unless another item follows it.
          if (!(i + 1 < lines.length && isListMarker(lines[i + 1]) && indentOf(lines[i + 1]) >= base)) break;
        } else if (indentOf(l) < base) {
          break;
        } else if (!isListMarker(l) && indentOf(l) <= base) {
          break;
        }
        if (i > start && isListMarker(l) && proseUnit(l.trimStart().replace(/^-\s*/, ""))) break;
        i++;
      }
      const items = parseList(lines.slice(start, i));
      if (items.length) blocks.push({ type: "list", items });
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }
  flush();
  return blocks;
}

export function parseNote(id: string, markdown: string): Note {
  const { front, body } = splitFrontMatter(markdown);
  return { id, title: frontValue(front, "title") ?? id, blocks: parseBlocks(body) };
}
