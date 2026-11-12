// "Match found", over whatever tab is open, while the page is open. A page in
// the background also gets a system notification; with the page closed, the
// push from the server does that (push.ts, public/sw.js).

import { useEffect, useState } from "react";
import { siteConfig } from "../auth";
import { Icon } from "../ds/Icon";
import { getLink, onLinkEvent, onLinkWelcome, startLink } from "./link";
import { queueName } from "./protocol";
import { notifyHere, renewPush } from "./push";
import "./link.css";

const SHOW_MS = 90_000;

export function MatchBanner() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    startLink();
    // Every (re)connection: the server may have restarted and forgotten this phone.
    const offWelcome = onLinkWelcome(() => {
      void siteConfig().then((config) => renewPush(config.link?.pushKey ?? null));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvent = onLinkEvent((event) => {
      if (event.event !== "matchFound") return;
      const queue = event.queue ? queueName(event.queue, getLink().state?.queues ?? []) : "";
      const message = `Match found${queue ? ` in ${queue}` : ""}. Your game is starting on your PC.`;
      setText(message);
      clearTimeout(timer);
      timer = setTimeout(() => setText(null), SHOW_MS);
      if (document.hidden) void notifyHere("Match found", message);
    });
    return () => {
      offWelcome();
      offEvent();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!text) return;
    const before = document.title;
    document.title = "Match found! - FAForever";
    return () => {
      document.title = before;
    };
  }, [text]);

  if (!text) return null;
  return (
    <div className="match-banner" role="alert">
      <Icon name="bell" size={18} />
      <span>{text}</span>
      <button type="button" className="web-icon-button match-banner-close" aria-label="Close" onClick={() => setText(null)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
