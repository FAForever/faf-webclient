// Chat tab: FAF's IRC channels, live, for a logged-in visitor.
//
// Same layout as the Rust client's chat (ui/src/features/chat/ChatView.tsx):
// channels as a tab strip along the top, the conversation below it with its
// topic in the header, and the people in the channel on the right, grouped
// you first, then moderators, then everyone else. On a phone the people list
// takes the conversation's place behind a button.
//
// The connection itself lives in chat/client.ts, outside React, so it stays
// up while the visitor looks at other tabs.

import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { AuthError, beginLogin, completeLogin, getSession, logout, siteConfig, subscribeSession, type SiteConfig } from "../auth";
import { chat, type ChatMessage, type ChatUser, type Conversation } from "../chat/client";
import "../chat/chat.css";
import { profiles, type Profile } from "../chat/profiles";
import { Icon } from "../ds/Icon";
import { useFriendNames } from "../link/link";
import { ViewHeader } from "./common";

// The Rust client's default name colours (faf-domain settings/chat.rs).
const SELF_COLOR = "#ffdd00";
const MODERATOR_COLOR = "#32cd32";
const ADMIN_COLOR = "#ba55d3";
const FRIEND_COLOR = "#87cefa";
const PING_COLOR = "#ff8c00";
const CONTINUATION_MS = 5 * 60 * 1000;
const MAX_INPUT = 450;

const isAdmin = (user?: ChatUser) => !!user && /[~&]/.test(user.prefix);
const isModerator = (user?: ChatUser) => !!user && /[~&@%]/.test(user.prefix);

/** `friends`: lower-cased logins, known while the PC link is connected (link/link.ts). */
function nameStyle(name: string, user: ChatUser | undefined, self: string, friends: ReadonlySet<string>): CSSProperties | undefined {
  if (self && name.toLowerCase() === self.toLowerCase()) return { color: SELF_COLOR };
  if (isAdmin(user)) return { color: ADMIN_COLOR };
  if (isModerator(user)) return { color: MODERATOR_COLOR };
  if (friends.has(name.toLowerCase())) return { color: FRIEND_COLOR };
  return undefined;
}

function useChat() {
  useSyncExternalStore(chat.subscribe, chat.getVersion);
  return chat;
}

// ---- finishing a login on /auth/callback

let callbackRun: Promise<string> | null = null;

/** Runs once per page load, however often React mounts the view. */
function finishCallback(): Promise<string> {
  if (!callbackRun) callbackRun = completeLogin(window.location.search);
  return callbackRun;
}

// ---- message text

const LINK = /\bhttps?:\/\/[^\s<>"]+/gi;

function linkEnd(url: string): string {
  // Sentence punctuation after a link is not part of it.
  let end = url.replace(/[.,;:!?'"]+$/, "");
  while (end.endsWith(")") && (end.match(/\(/g)?.length ?? 0) < (end.match(/\)/g)?.length ?? 0)) end = end.slice(0, -1);
  return end;
}

/** The reader's own name in a message, marked. */
function withMentions(text: string, self: string, keyBase: string): ReactNode[] {
  if (!self || !text) return [text];
  const escaped = self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The character before the name is captured rather than looked behind,
  // which older Safari cannot do.
  const pattern = new RegExp(`(^|[^\\w-])(${escaped})(?=$|[^\\w-])`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + match[1].length;
    out.push(text.slice(last, start));
    out.push(
      <span key={`${keyBase}-m${start}`} className="chat-mention" style={{ color: PING_COLOR }}>
        {match[2]}
      </span>,
    );
    last = start + match[2].length;
  }
  out.push(text.slice(last));
  return out;
}

function renderBody(text: string, self: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    const url = linkEnd(match[0]);
    out.push(...withMentions(text.slice(last, start), self, `t${start}`));
    out.push(
      <a key={`l${start}`} className="chat-link" href={url} target="_blank" rel="noopener noreferrer nofollow">
        {url}
      </a>,
    );
    last = start + url.length;
  }
  out.push(...withMentions(text.slice(last), self, "end"));
  return out;
}

// 24-hour, the Rust client's default: the column is sized for "21:05".
const timeLabel = (time: number) => new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayKey = (time: number) => new Date(time).toDateString();

function dayLabel(time: number): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(time) === today.toDateString()) return "Today";
  if (dayKey(time) === yesterday.toDateString()) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function continues(message: ChatMessage, previous?: ChatMessage) {
  return (
    !!previous &&
    message.kind === "message" &&
    previous.kind === "message" &&
    message.sender === previous.sender &&
    message.time - previous.time >= 0 &&
    message.time - previous.time <= CONTINUATION_MS
  );
}

// ---- the message log

const MessageLog = memo(function MessageLog({
  conversation,
  version,
  self,
  connected,
}: {
  conversation: Conversation;
  version: number;
  self: string;
  connected: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [missed, setMissed] = useState(false);
  const friends = useFriendNames();
  const messages = conversation.messages;

  // A new conversation opens at its latest line.
  useLayoutEffect(() => {
    atBottom.current = true;
    setMissed(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.key]);

  // New lines keep the log at the bottom only if the reader was there.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom.current) el.scrollTop = el.scrollHeight;
    else setMissed(true);
  }, [version]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom.current) setMissed(false);
  };

  const users = conversation.users;
  return (
    <div className="chat-scroll-wrap">
      <div className="chat-messages surface-panel" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={-1}>
        {messages.length === 0 ? (
          <p className="muted chat-empty">{connected ? "No messages yet." : "Not connected: messages will appear once you're online."}</p>
        ) : (
          messages.map((message, i) => {
            const previous = messages[i - 1];
            const newDay = !previous || dayKey(previous.time) !== dayKey(message.time);
            const continued = !newDay && continues(message, previous);
            const label = timeLabel(message.time);
            const withTime = newDay || !previous || label !== timeLabel(previous.time);
            const user = users.get(message.sender.toLowerCase());
            const style = nameStyle(message.sender, user, self, friends);
            const fromSelf = !!self && message.sender.toLowerCase() === self.toLowerCase();
            const nick = (
              <button
                type="button"
                className={style ? "chat-nick" : "chat-nick is-monochrome"}
                style={style}
                title={fromSelf ? undefined : `Message ${message.sender}`}
                onClick={() => chat.openPrivate(message.sender)}
              >
                {message.sender}
              </button>
            );
            const classes = [
              "chat-message",
              `is-${message.kind}`,
              fromSelf ? "is-self" : "",
              continued ? "is-continued" : "",
              message.ping ? "is-ping" : "",
            ].filter(Boolean).join(" ");
            return (
              <Fragment key={message.id}>
                {newDay && (
                  <div className="chat-day-divider" role="separator">
                    <span>{dayLabel(message.time)}</span>
                  </div>
                )}
                <div className={classes}>
                  {message.kind === "info" || message.kind === "error" ? (
                    <>
                      <span className="chat-message-avatar" aria-hidden="true" />
                      <span className="chat-message-body">{renderBody(message.text, "")}</span>
                    </>
                  ) : message.kind === "action" ? (
                    <>
                      <span className="chat-message-avatar" aria-hidden="true" />
                      <span className="chat-action-star" aria-hidden="true">*</span>
                      <span className="chat-message-body">
                        {nick} {renderBody(message.text, self)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="chat-message-avatar" aria-hidden="true" />
                      {continued ? <span className="chat-message-nick is-continued" aria-hidden="true" /> : nick}
                      <span className="chat-message-body">{renderBody(message.text, self)}</span>
                    </>
                  )}
                  <span className="chat-message-time" title={new Date(message.time).toLocaleString()}>
                    {withTime ? label : ""}
                  </span>
                </div>
              </Fragment>
            );
          })
        )}
      </div>
      {missed && (
        <button
          type="button"
          className="chat-jump"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            atBottom.current = true;
            setMissed(false);
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
});

// ---- the people in a channel

// The Rust client's order. Friends are known only while the PC link is connected.
type Group = "self" | "moderators" | "friends" | "clan" | "players";
const GROUP_LABEL: Record<Group, string> = { self: "You", moderators: "Moderators & admins", friends: "Friends", clan: "Clan", players: "Players" };

/** The people in a channel who are connected right now (see ChatUser.away). */
export function onlineUsers(conversation: Conversation): ChatUser[] {
  return [...conversation.users.values()].filter((user) => user.away === false);
}

function RosterRow({
  user,
  group,
  self,
  friends,
  profile,
  onOpen,
}: {
  user: ChatUser;
  group: Group;
  self: string;
  friends: ReadonlySet<string>;
  profile: Profile | null | undefined;
  onOpen: (nick: string) => void;
}) {
  const style = nameStyle(user.name, user, self, friends);
  return (
    <li className="chat-roster-item">
      <div className="chat-roster-user">
        <button
          type="button"
          className="chat-roster-identity"
          title={group === "self" ? undefined : `Message ${user.name}`}
          onClick={() => group !== "self" && onOpen(user.name)}
        >
          <span className="chat-avatar">
            {profile?.avatarUrl && (
              <img src={profile.avatarUrl} alt="" title={profile.avatarTooltip ?? undefined} width={40} height={20} loading="lazy" decoding="async" draggable={false} />
            )}
          </span>
          <span className={style ? "chat-nick" : "chat-nick is-monochrome"} style={style}>
            {profile?.clan && <span className="chat-clan">[{profile.clan}]</span>}
            {user.name}
          </span>
        </button>
      </div>
    </li>
  );
}

const Roster = memo(function Roster({
  conversation,
  version,
  self,
  onOpen,
}: {
  conversation: Conversation;
  version: number;
  self: string;
  onOpen: (nick: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const profileVersion = useSyncExternalStore(profiles.subscribe, profiles.getVersion);
  const friends = useFriendNames();

  // `version` stands for the contents of the users map, which is mutated in place.
  const online = useMemo(() => onlineUsers(conversation), [conversation, version]);

  // Avatars and clan tags for whoever is on the list.
  useEffect(() => {
    profiles.want(online.map((user) => user.name));
  }, [online]);

  const myClan = self ? profiles.get(self)?.clan ?? null : null;

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const result: Record<Group, ChatUser[]> = { self: [], moderators: [], friends: [], clan: [], players: [] };
    for (const user of online) {
      const clan = profiles.get(user.name)?.clan ?? null;
      if (needle && !user.name.toLowerCase().includes(needle) && !(clan && clan.toLowerCase().includes(needle))) continue;
      const group: Group =
        self && user.name.toLowerCase() === self.toLowerCase()
          ? "self"
          : isModerator(user)
            ? "moderators"
            : friends.has(user.name.toLowerCase())
              ? "friends"
              : myClan && clan === myClan
                ? "clan"
                : "players";
      result[group].push(user);
    }
    for (const list of Object.values(result)) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    return result;
    // profileVersion: clans arrive after the names do.
  }, [online, filter, self, myClan, profileVersion, friends]);

  const total = online.length;
  const shown = Object.values(groups).reduce((sum, list) => sum + list.length, 0);

  return (
    <div className="chat-roster surface-panel" id="chat-roster">
      <div className="chat-roster-search">
        <label className="chat-roster-search-field">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={filter}
            placeholder={conversation.presenceKnown ? `${total} online, type to filter` : "Type to filter"}
            aria-label={`Filter the people online in ${conversation.name}`}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
      </div>
      <div className="chat-roster-list">
        {!conversation.presenceKnown ? (
          <p className="muted chat-empty">Checking who is online…</p>
        ) : shown === 0 && total > 0 ? (
          <p className="muted chat-empty">No user matches "{filter.trim()}".</p>
        ) : (
          <ul className="chat-roster-virtual-window">
            {(Object.keys(GROUP_LABEL) as Group[]).map((group) =>
              groups[group].length === 0 ? null : (
                <Fragment key={group}>
                  <li className="chat-roster-group-header">
                    <h3>
                      <button
                        type="button"
                        className="chat-roster-heading"
                        aria-expanded={!collapsed[group]}
                        onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))}
                      >
                        <Icon name="chevronRight" size={15} className={collapsed[group] ? "chat-roster-chevron" : "chat-roster-chevron is-open"} />
                        <span className="chat-roster-heading-label">{GROUP_LABEL[group]}</span>
                        {group !== "self" && <span className="chat-roster-count">{groups[group].length}</span>}
                      </button>
                    </h3>
                  </li>
                  {!collapsed[group] &&
                    groups[group].map((user) => (
                      <RosterRow key={user.name} user={user} group={group} self={self} friends={friends} profile={profiles.get(user.name)} onOpen={onOpen} />
                    ))}
                </Fragment>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
});

// ---- dragging the people list wider

const ROSTER_MIN_WIDTH = 200;
const ROSTER_MAX_WIDTH = 600;
const ROSTER_DEFAULT_WIDTH = 280;
const ROSTER_WIDTH_KEY = "faf-web.chat.rosterWidth";
const clampWidth = (width: number) => Math.min(ROSTER_MAX_WIDTH, Math.max(ROSTER_MIN_WIDTH, Math.round(width)));

function savedRosterWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(ROSTER_WIDTH_KEY));
    return value ? clampWidth(value) : ROSTER_DEFAULT_WIDTH;
  } catch {
    return ROSTER_DEFAULT_WIDTH;
  }
}

function saveRosterWidth(width: number) {
  try {
    window.localStorage.setItem(ROSTER_WIDTH_KEY, String(width));
  } catch {
    // Not kept: the default next time.
  }
}

/** The Rust client's handle (features/chat/roster/RosterResizeHandle.tsx): drag, or arrow keys. */
function RosterResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => onResize(clampWidth(drag.startWidth + drag.startX - event.clientX));
    const stop = () => {
      setDrag(null);
      saveRosterWidth(latest.current);
    };
    document.documentElement.classList.add("is-resizing-chat-roster");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.documentElement.classList.remove("is-resizing-chat-roster");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [drag, onResize]);

  return (
    <div
      className={`chat-roster-resizer${drag ? " is-active" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label="Resize the people list"
      aria-orientation="vertical"
      aria-valuemin={ROSTER_MIN_WIDTH}
      aria-valuemax={ROSTER_MAX_WIDTH}
      aria-valuenow={width}
      aria-controls="chat-roster"
      title="Drag to resize"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        setDrag({ startX: event.clientX, startWidth: width });
      }}
      onDoubleClick={() => {
        onResize(ROSTER_DEFAULT_WIDTH);
        saveRosterWidth(ROSTER_DEFAULT_WIDTH);
      }}
      onKeyDown={(event) => {
        const step = 12;
        const next =
          event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step : event.key === "Home" ? ROSTER_MIN_WIDTH : event.key === "End" ? ROSTER_MAX_WIDTH : null;
        if (next === null) return;
        event.preventDefault();
        const clamped = clampWidth(next);
        onResize(clamped);
        saveRosterWidth(clamped);
      }}
    />
  );
}

// ---- channel tabs

function ChannelTabs({ conversations, active }: { conversations: Conversation[]; active: string }) {
  const [joining, setJoining] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (joining) inputRef.current?.focus();
  }, [joining]);

  const close = () => {
    setJoining(false);
    setDraft("");
  };

  return (
    <nav className="section-tabs chat-tabs" role="tablist" aria-label="Channels">
      {conversations.map((conv) => {
        const isActive = conv.key === active;
        const closable = conv.key !== chat.defaultChannel.toLowerCase();
        return (
          <div key={conv.key} role="presentation" className={`chat-tab${closable ? " is-closable" : ""}`}>
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`chat-tab-button${isActive ? " active" : ""}`}
              title={conv.name}
              onClick={() => chat.select(conv.key)}
            >
              <Icon name={conv.channel ? "chat" : "users"} size={15} />
              <span className="section-tab-label chat-tab-name">{conv.name}</span>
              {conv.unread > 0 && (
                <span className={`section-tab-count${conv.mentions > 0 ? " is-mention" : ""}`} aria-label={`${conv.unread} unread`}>
                  {conv.unread > 99 ? "99+" : conv.unread}
                </span>
              )}
            </button>
            {closable && (
              <button
                type="button"
                className="chat-tab-close"
                aria-label={`Close ${conv.name}`}
                title={conv.channel ? "Close the tab. You stay in the channel; type /part to leave it." : "Close"}
                onClick={(event) => {
                  event.stopPropagation();
                  chat.hide(conv.key);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className={`chat-tab-add${joining ? " is-active" : ""}`}
        aria-label={joining ? "Close channel join field" : "Join a channel"}
        aria-expanded={joining}
        title={joining ? "Close" : "Join a channel"}
        onClick={() => (joining ? close() : setJoining(true))}
      >
        <Icon name={joining ? "close" : "plus"} size={16} />
      </button>
      {joining && (
        <form
          className="chat-tab-join"
          onSubmit={(event) => {
            event.preventDefault();
            const name = draft.trim();
            if (name) chat.join(name);
            close();
          }}
        >
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            value={draft}
            placeholder="channel name, then Enter"
            aria-label="Channel to join"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && close()}
          />
        </form>
      )}
    </nav>
  );
}

// ---- composer

function Composer({ target, disabled }: { target: string; disabled: boolean }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="chat-compose-shell"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.trim() || disabled) return;
        chat.submit(draft);
        setDraft("");
      }}
    >
      <div className="chat-compose">
        <input
          className="chat-input chat-compose-input"
          type="text"
          maxLength={MAX_INPUT}
          value={draft}
          enterKeyHint="send"
          autoComplete="off"
          placeholder={disabled ? "Not connected" : `Message ${target}: /me, /msg, /join`}
          aria-label={`Message ${target}`}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={disabled || !draft.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

// ---- logged out

function LoginCard({ problem }: { problem: string }) {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void siteConfig().then(setConfig);
  }, []);

  const available = config ? Boolean(config.login && config.chat) : true;

  return (
    <div className="web-view">
      <ViewHeader title="Chat" description="FAF's chat channels, live." />
      <section className="web-card chat-login">
        <h2>
          <Icon name="chat" size={18} /> Log in to chat
        </h2>
        {available ? (
          <>
            <p>Chat needs your FAF account. You log in on FAF's own page; this site never sees your password.</p>
            <p className="chat-login-note">
              Your desktop client stays connected. Both show the same channels, so leaving a channel here leaves it there too.
            </p>
          </>
        ) : (
          <p>Chat login isn't available on this site yet.</p>
        )}
        {(error || problem) && <p className="chat-login-error">{error || problem}</p>}
        {available && (
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !config}
            onClick={() => {
              setBusy(true);
              setError("");
              beginLogin("/chat").catch((err: unknown) => {
                setBusy(false);
                setError(err instanceof Error ? err.message : "Could not start the login.");
              });
            }}
          >
            <Icon name="user" size={15} /> Log in with FAF
          </button>
        )}
      </section>
    </div>
  );
}

// ---- the tab

export function ChatView() {
  const session = useSyncExternalStore(subscribeSession, getSession);
  const client = useChat();
  const [callback, setCallback] = useState(() => window.location.pathname === "/auth/callback");
  const [loginError, setLoginError] = useState("");
  const [rosterOpen, setRosterOpen] = useState(false);
  const [rosterWidth, setRosterWidth] = useState(savedRosterWidth);

  // Back from FAF's login page.
  useEffect(() => {
    if (!callback) return;
    let alive = true;
    finishCallback()
      .catch((err: unknown) => {
        if (alive) setLoginError(err instanceof AuthError || err instanceof Error ? err.message : "The login did not finish.");
        return "/chat";
      })
      .then((to) => {
        window.history.replaceState(null, "", to);
        if (alive) setCallback(false);
        // A login started from another tab (Replays' "My replays") goes back there.
        if (!to.startsWith("/chat")) window.dispatchEvent(new PopStateEvent("popstate"));
      });
    return () => {
      alive = false;
    };
  }, [callback]);

  // Connect while logged in, for as long as the page is open.
  const userName = session?.user.name ?? "";
  useEffect(() => {
    // Not while a login is finishing: it may be on its way to another tab.
    if (!userName || callback) return;
    let alive = true;
    void siteConfig().then((config) => {
      if (!alive || !config.chat) return;
      client.configure(config.chat.url, config.chat.channel);
      client.start();
    });
    return () => {
      alive = false;
    };
  }, [userName, client, callback]);

  // Back to the page after a while away: reconnect at once, and what is on
  // screen has been read.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      client.retryNow();
      client.markRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [client]);

  const active = client.active;
  useEffect(() => {
    if (document.visibilityState === "visible") client.markRead();
  }, [client, active?.key, active?.unread]);

  if (callback) {
    return (
      <div className="web-view">
        <ViewHeader title="Chat" description="FAF's chat channels, live." />
        <p className="muted web-state">Finishing login…</p>
      </div>
    );
  }

  if (!session) return <LoginCard problem={loginError || client.problem} />;

  const connected = client.status === "connected";
  const conversations = client.visibleConversations();
  const self = client.nick || session.user.name;
  const onlineCount = active ? onlineUsers(active).length : 0;

  let context: ReactNode;
  if (!connected) {
    const text =
      client.status === "reconnecting"
        ? "Connection lost. Reconnecting…"
        : client.status === "failed"
          ? client.problem || "Not connected."
          : "Connecting…";
    context = (
      <span className={`chat-status${client.status === "failed" || client.status === "reconnecting" ? " is-problem" : ""}`} role="status">
        {text}
        {(client.status === "failed" || client.status === "reconnecting") && (
          <button type="button" className="chat-head-button" onClick={() => client.retryNow()}>
            Retry
          </button>
        )}
      </span>
    );
  } else if (active?.topic && active.topic.replace(/^#+/, "").toLowerCase() !== active.name.replace(/^#+/, "").toLowerCase()) {
    context = (
      <p className="chat-topic" title={active.topic}>
        {active.topic}
      </p>
    );
  } else if (active && !active.channel) {
    context = <p className="chat-topic">Private conversation with {active.name}</p>;
  } else if (active) {
    context = (
      <span className="chat-online-count">
        <Icon name="users" size={14} />
        <span>{active.presenceKnown ? `${onlineCount} ${onlineCount === 1 ? "person" : "people"} online` : "Checking who is online…"}</span>
      </span>
    );
  }

  return (
    <div
      className={`chat${active && !active.channel ? " is-private" : ""}${rosterOpen && active?.channel ? " is-roster-open" : ""}`}
      style={{ "--chat-roster-width": `${rosterWidth}px` } as CSSProperties}
    >
      <section className="chat-main">
        <ChannelTabs conversations={conversations} active={active?.key ?? ""} />
        <div className="chat-channel-panel">
          <header className="chat-head">
            {context}
            <span className="spacer" />
            <div className="chat-head-controls">
              {active?.channel && (
                <button type="button" className="chat-head-button chat-roster-toggle" onClick={() => setRosterOpen(true)}>
                  <Icon name="users" size={14} /> {active.presenceKnown ? onlineCount : "…"}
                </button>
              )}
              <button
                type="button"
                className="chat-head-button"
                title={`Logged in as ${session.user.name}`}
                onClick={() => {
                  client.stop();
                  logout();
                }}
              >
                <Icon name="logout" size={14} /> Log out
              </button>
            </div>
          </header>
          {active ? (
            <MessageLog conversation={active} version={active.messagesVersion} self={self} connected={connected} />
          ) : (
            <div className="chat-scroll-wrap">
              <p className="muted chat-empty">
                <Icon name="chat" size={18} /> {connected ? "No channel open. Join one with +." : "Connecting…"}
              </p>
            </div>
          )}
          <Composer key={active?.key ?? ""} target={active?.name ?? ""} disabled={!connected || !active} />
        </div>
      </section>

      {active?.channel && (
        <div className="chat-roster-shell">
          <RosterResizeHandle width={rosterWidth} onResize={setRosterWidth} />
          <button type="button" className="chat-head-button chat-roster-toggle chat-roster-back" onClick={() => setRosterOpen(false)}>
            <Icon name="arrowLeft" size={14} /> Back to {active.name}
          </button>
          <Roster
            conversation={active}
            version={active.usersVersion}
            self={self}
            onOpen={(nick) => {
              setRosterOpen(false);
              client.openPrivate(nick);
            }}
          />
        </div>
      )}
    </div>
  );
}
