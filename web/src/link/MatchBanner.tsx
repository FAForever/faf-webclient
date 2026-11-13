// "Match found", or "Your PC needs you", over whatever tab is open, while the
// page is open. A page in the background also gets a system notification; with
// the page closed, the push from the server does that (push.ts, public/sw.js).

import { useEffect, useState } from "react";
import { siteConfig } from "../auth";
import { Icon } from "../ds/Icon";
import { getLink, onLinkEvent, onLinkWelcome, startLink, type LinkEvent } from "./link";
import { queueName } from "./protocol";
import { notifyHere, renewPush } from "./push";
import "./link.css";

const SHOW_MS = 90_000;

interface Banner {
  /** The notification's title, and the tab's while the banner shows. */
  title: string;
  text: string;
  /** The push from the server for the same event carries the same tag. */
  tag: string;
}

function bannerFor(event: LinkEvent): Banner | null {
  if (event.event === "matchFound") {
    const queue = event.title ?? (event.queue ? queueName(event.queue, getLink().state?.queues ?? []) : "");
    return {
      title: "Match found",
      text: `Match found${queue ? ` in ${queue}` : ""}. Your game is starting on your PC.`,
      tag: "faf-match-found",
    };
  }
  if (event.event === "attention") {
    return {
      title: "Your PC needs you",
      text: event.reason ?? "A game you asked your PC to join needs you there.",
      tag: "faf-pc-attention",
    };
  }
  return null;
}

export function MatchBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    startLink();
    // Every (re)connection: the server may have restarted and forgotten this phone.
    const offWelcome = onLinkWelcome(() => {
      void siteConfig().then((config) => renewPush(config.link?.pushKey ?? null));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvent = onLinkEvent((event) => {
      const next = bannerFor(event);
      if (!next) return;
      setBanner(next);
      clearTimeout(timer);
      timer = setTimeout(() => setBanner(null), SHOW_MS);
      if (document.hidden) void notifyHere(next.title, next.text, next.tag);
    });
    return () => {
      offWelcome();
      offEvent();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!banner) return;
    const before = document.title;
    document.title = `${banner.title}! - FAForever`;
    return () => {
      document.title = before;
    };
  }, [banner]);

  if (!banner) return null;
  return (
    <div className={`match-banner${banner.tag === "faf-pc-attention" ? " is-attention" : ""}`} role="alert">
      <Icon name="bell" size={18} />
      <span>
        {banner.tag === "faf-pc-attention" && <strong>{banner.title}: </strong>}
        {banner.text}
      </span>
      <button type="button" className="web-icon-button match-banner-close" aria-label="Close" onClick={() => setBanner(null)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
