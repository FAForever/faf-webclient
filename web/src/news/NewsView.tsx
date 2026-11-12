// The News tab: FAF's news hub, the articles the website's /newshub page and
// the desktop clients show, read from the same JSON the website's own page
// loads (FAForever/website, WordpressRepository.fetchNewshub) and laid out to
// fit a phone as well as a monitor.
//
// Titles and texts arrive as WordPress HTML. They are turned into plain text
// with DOMParser, which runs no scripts and loads nothing, and only that text
// is put on the page.

import { useMemo, useState, type ReactNode } from "react";
import { formatDate, pick } from "../api";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { fafUrl } from "../hosts";
import { LoadFailed, Loading, useJson, ViewHeader } from "../views/common";
import "./news.css";

interface Article {
  key: string;
  title: string;
  text: string;
  link: string | null;
  image: string | null;
  date: string;
  author: string;
  order: number;
}

const parser = typeof DOMParser !== "undefined" ? new DOMParser() : null;

function plainText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  // Block ends become spaces, so "</p><p>" does not glue two words together.
  const spaced = html.replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, " $&");
  let text: string;
  if (parser) {
    const body = parser.parseFromString(spaced, "text/html").body;
    for (const el of body.querySelectorAll("script, style, noscript, template")) el.remove();
    text = body.textContent ?? "";
  } else {
    text = spaced.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "");
  }
  return text.replace(/\s+/g, " ").trim();
}

const httpsOrNull = (value: unknown) => (typeof value === "string" && /^https:\/\/\S+$/.test(value.trim()) ? value.trim() : null);

/** About `max` characters, cut at a word. */
function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).replace(/[\s,.;:-]+$/, "")}...`;
}

function toArticles(data: unknown): Article[] {
  const list = Array.isArray(data) ? data : [];
  const articles = list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, i) => {
      const order = Number(pick(item, "sortIndex"));
      return {
        key: `${i}-${String(pick(item, "link") ?? pick(item, "title") ?? "")}`,
        title: plainText(pick(item, "title")) || "Untitled",
        text: plainText(pick(item, "content")),
        link: httpsOrNull(pick(item, "link")),
        image: httpsOrNull(pick(item, "media")),
        date: String(pick(item, "date") ?? ""),
        author: plainText(pick(item, "author")),
        order: Number.isFinite(order) ? order : -i,
      };
    });
  // Highest sort index first, as the website orders them.
  return articles.sort((a, b) => b.order - a.order);
}

function Picture({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`${className} news-picture is-placeholder`} aria-hidden="true">
        <Icon name="news" size={36} />
      </div>
    );
  }
  return <img className={`${className} news-picture`} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function Byline({ article }: { article: Article }) {
  const parts = [formatDate(article.date), article.author].filter((p) => p && p !== "-");
  return parts.length ? <p className="news-byline">{parts.join(" · ")}</p> : null;
}

/** A card is a link when the article has one, and a plain card when it has not. */
function CardShell({ article, className, children }: { article: Article; className: string; children: ReactNode }) {
  return article.link ? (
    <a className={`${className} is-link`} href={article.link} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <article className={className}>{children}</article>
  );
}

export function NewsView() {
  const load = useJson<unknown>("/api/news/newshub.json", 600_000);
  const articles = useMemo(() => (load.state === "ready" ? toArticles(load.data) : []), [load]);
  const [lead, ...rest] = articles;

  return (
    <div className="web-view news-view">
      <ViewHeader
        title="News"
        description="What's new on FAF."
        actions={
          <a className="web-button" href={`${fafUrl("www")}/newshub`} target="_blank" rel="noopener noreferrer">
            Website <Icon name="external" size={13} />
          </a>
        }
      />
      {load.state === "loading" && <Loading what="the news" />}
      {load.state === "error" && <LoadFailed icon="news" what="the news" status={load.status} code={load.code} />}
      {load.state === "ready" && articles.length === 0 && <EmptyState icon="news" title="No news right now" bordered />}

      {lead && (
        <CardShell article={lead} className="news-lead">
          <Picture src={lead.image} className="news-lead-picture" />
          <div className="news-lead-body">
            <h2>{lead.title}</h2>
            <Byline article={lead} />
            {lead.text && <p className="news-text">{excerpt(lead.text, 420)}</p>}
            {lead.link && (
              <span className="news-more">
                Read more <Icon name="arrowRight" size={13} />
              </span>
            )}
          </div>
        </CardShell>
      )}

      {rest.length > 0 && (
        <div className="news-grid">
          {rest.map((article) => (
            <CardShell key={article.key} article={article} className="news-card">
              <Picture src={article.image} className="news-card-picture" />
              <div className="news-card-body">
                <h3>{article.title}</h3>
                <Byline article={article} />
                {article.text && <p className="news-text">{excerpt(article.text, 180)}</p>}
              </div>
            </CardShell>
          ))}
        </div>
      )}
    </div>
  );
}
