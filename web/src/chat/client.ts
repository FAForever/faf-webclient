// The chat connection: one IRC session over a WebSocket, straight from the
// browser to FAF's chat server (Ergo), logged in with the visitor's account.
//
// Modelled on the Rust client's crates/faf-app/src/infra/irc.rs and
// irc_session.rs: the same subprotocol, capabilities, SASL login and history
// requests. It lives outside React so the connection survives switching tabs.
//
// FAF's chat lets one account be connected several times at once, so the
// desktop client stays online. Those connections share their channels: a
// channel left here is left on the desktop too. That is why closing a tab
// here only hides it, and leaving takes an explicit /part.

import { freshChatToken, AuthError, type Session } from "../auth";
import { ctcpAction, formatLine, isChannel, isCtcp, parseLine, saslPlain, stripFormatting, type IrcLine } from "./irc";

export type ChatStatus = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export type MessageKind = "message" | "action" | "notice" | "info" | "error";

export interface ChatMessage {
  id: string;
  time: number;
  sender: string;
  text: string;
  kind: MessageKind;
  /** Mentions the visitor by name. */
  ping: boolean;
}

export interface ChatUser {
  name: string;
  /** Channel status symbols, highest first, e.g. "@" or "~@". */
  prefix: string;
}

export interface Conversation {
  name: string;
  key: string;
  channel: boolean;
  topic: string;
  users: Map<string, ChatUser>;
  messages: ChatMessage[];
  unread: number;
  mentions: number;
  hidden: boolean;
  /** Private conversations: whether their history has been asked for. */
  historyAsked: boolean;
  /** Bumped whenever `messages` or `users` change, for memoised views. */
  messagesVersion: number;
  usersVersion: number;
}

const SUBPROTOCOL = "binary.ircv3.net";
const WANTED_CAPS = ["sasl", "server-time", "message-tags", "multi-prefix", "batch", "draft/chathistory", "echo-message"];
const CHANNEL_HISTORY = 100;
const PRIVATE_HISTORY = 50;
const MAX_MESSAGES = 600;
const PING_EVERY_MS = 60_000;
const DEAD_AFTER_MS = 150_000;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

const keyOf = (name: string) => name.toLowerCase();

let nextId = 1;

class ChatClient {
  status: ChatStatus = "idle";
  /** Why the chat is not connected, when that needs saying. */
  problem = "";
  nick = "";
  defaultChannel = "#aeolus";
  conversations = new Map<string, Conversation>();
  activeKey = "";
  version = 0;

  private url = "wss://chat.faforever.com";
  private ws: WebSocket | null = null;
  private session: Session | null = null;
  private listeners = new Set<() => void>();
  private notifyQueued = false;
  private closing = false;
  private opening = false;
  private attempt = 0;
  private reconnectTimer = 0;
  private keepaliveTimer = 0;
  private lastHeard = 0;
  private authRetried = false;
  private offeredCaps = new Set<string>();
  private caps = new Set<string>();
  private registered = false;
  private wantedChannels = new Set<string>();
  /** mode letter -> status symbol, from ISUPPORT PREFIX. */
  private prefixModes: Record<string, string> = { q: "~", a: "&", o: "@", h: "%", v: "+" };
  private prefixOrder = "~&@%+";
  /** CHANMODES groups A, B, C: modes that take a parameter. */
  private paramModes = { always: "beIkqaohv", whenSet: "l" };
  private pendingNames = new Map<string, ChatUser[]>();
  /** batch id -> root history batch id */
  private batchRoots = new Map<string, string>();
  private historyHeld = new Map<string, { target: string; lines: { conversation: string; message: ChatMessage }[] }>();

  // ---- subscription

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private changed() {
    this.version++;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    // A burst (a history batch, a 600-name NAMES list) redraws once.
    setTimeout(() => {
      this.notifyQueued = false;
      this.listeners.forEach((listener) => listener());
    }, 0);
  }

  // ---- connection

  configure(url: string, channel: string) {
    this.url = url;
    this.defaultChannel = channel;
  }

  /**
   * Connects with the logged-in account. Called whenever the Chat tab opens,
   * so it does nothing while a connection is up or on its way.
   */
  start() {
    if (this.status === "failed") {
      this.retryNow();
      return;
    }
    if (this.status !== "idle") return;
    this.closing = false;
    this.wantedChannels.add(keyOf(this.defaultChannel));
    void this.open();
  }

  /** Disconnects for good, e.g. on logout. */
  stop() {
    this.closing = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.keepaliveTimer);
    if (this.ws) {
      this.sendRaw("QUIT :Leaving");
      this.ws.close();
    }
    this.ws = null;
    this.session = null;
    this.status = "idle";
    this.problem = "";
    this.conversations.clear();
    this.wantedChannels.clear();
    this.activeKey = "";
    this.attempt = 0;
    this.changed();
  }

  private async open(rejectedToken?: string) {
    // One attempt at a time: a timer, a returning page and the tab opening
    // can all ask at once.
    if (this.opening || this.ws) return;
    this.opening = true;
    this.status = this.attempt > 0 ? "reconnecting" : "connecting";
    this.problem = "";
    this.changed();
    try {
      this.session = await freshChatToken(rejectedToken);
    } catch (err) {
      this.opening = false;
      if (this.closing) return;
      this.status = "failed";
      this.problem = err instanceof AuthError ? err.message : "Could not log in to chat.";
      if (err instanceof AuthError && err.code === "offline") this.scheduleReconnect();
      this.changed();
      return;
    }
    this.opening = false;
    if (this.closing) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, [SUBPROTOCOL]);
    } catch {
      this.fail("The chat server could not be reached.");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.registered = false;
    this.offeredCaps.clear();
    this.caps.clear();
    this.batchRoots.clear();
    this.historyHeld.clear();
    this.pendingNames.clear();

    const decoder = new TextDecoder();
    ws.onopen = () => {
      this.lastHeard = Date.now();
      this.sendRaw("CAP LS 302");
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = window.setInterval(() => this.keepalive(), PING_EVERY_MS / 2);
    };
    ws.onmessage = (event) => {
      this.lastHeard = Date.now();
      const text = typeof event.data === "string" ? event.data : decoder.decode(event.data as ArrayBuffer);
      for (const raw of text.split(/\r?\n/)) {
        if (!raw) continue;
        const line = parseLine(raw);
        if (line) this.handle(line);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearInterval(this.keepaliveTimer);
      if (this.closing) return;
      if (this.status === "failed") return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and decides what happens next.
    };
  }

  private keepalive() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const quiet = Date.now() - this.lastHeard;
    if (quiet > DEAD_AFTER_MS) {
      // A phone that slept, or a network that changed: the socket is gone
      // without anyone saying so.
      this.ws.close();
      return;
    }
    if (quiet > PING_EVERY_MS) this.sendRaw("PING :faf-web");
  }

  private scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer);
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.status = "reconnecting";
    this.changed();
    this.reconnectTimer = window.setTimeout(() => void this.open(), delay);
  }

  /** Reconnect now rather than at the end of the wait, e.g. when the page comes back. */
  retryNow() {
    if (this.closing || this.ws) return;
    if (this.status !== "reconnecting" && this.status !== "failed") return;
    window.clearTimeout(this.reconnectTimer);
    this.authRetried = false;
    void this.open();
  }

  private fail(problem: string) {
    this.status = "failed";
    this.problem = problem;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.changed();
  }

  private sendRaw(line: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(new TextEncoder().encode(line));
    return true;
  }

  // ---- conversations

  get active(): Conversation | undefined {
    return this.conversations.get(this.activeKey);
  }

  visibleConversations(): Conversation[] {
    return [...this.conversations.values()].filter((c) => !c.hidden);
  }

  private conversation(name: string, create = true): Conversation | undefined {
    const key = keyOf(name);
    let conv = this.conversations.get(key);
    if (!conv && create) {
      conv = {
        name,
        key,
        channel: isChannel(name),
        topic: "",
        users: new Map(),
        messages: [],
        unread: 0,
        mentions: 0,
        hidden: false,
        historyAsked: false,
        messagesVersion: 0,
        usersVersion: 0,
      };
      this.conversations.set(key, conv);
      if (!this.activeKey || this.conversations.get(this.activeKey)?.hidden) this.activeKey = key;
    }
    return conv;
  }

  select(key: string) {
    const conv = this.conversations.get(key);
    if (!conv) return;
    this.activeKey = key;
    conv.hidden = false;
    conv.unread = 0;
    conv.mentions = 0;
    this.changed();
  }

  /** The visible conversation is being read: clears its unread count. */
  markRead() {
    const conv = this.active;
    if (conv && (conv.unread || conv.mentions)) {
      conv.unread = 0;
      conv.mentions = 0;
      this.changed();
    }
  }

  /** Hides a tab. Channels stay joined: see the note at the top. */
  hide(key: string) {
    const conv = this.conversations.get(key);
    if (!conv) return;
    conv.hidden = true;
    if (this.activeKey === key) {
      const next = this.visibleConversations()[0];
      this.activeKey = next ? next.key : "";
    }
    this.changed();
  }

  join(name: string) {
    const channel = name.startsWith("#") ? name : `#${name}`;
    if (!/^#[^\s,\x07]{1,49}$/.test(channel)) {
      this.info(`"${name}" is not a channel name.`, "error");
      return;
    }
    this.wantedChannels.add(keyOf(channel));
    const existing = this.conversations.get(keyOf(channel));
    if (existing) {
      this.select(existing.key);
      return;
    }
    this.pendingSelect = keyOf(channel);
    this.sendRaw(formatLine("JOIN", channel));
  }

  private pendingSelect = "";

  openPrivate(nick: string) {
    if (!nick || keyOf(nick) === keyOf(this.nick)) return;
    const conv = this.conversation(nick)!;
    this.select(conv.key);
    this.catchUp(conv);
  }

  /** A private conversation's earlier lines, asked for once. */
  private catchUp(conv: Conversation) {
    if (conv.channel || conv.historyAsked || !this.registered) return;
    conv.historyAsked = true;
    this.requestHistory(conv.name, PRIVATE_HISTORY);
  }

  private requestHistory(target: string, lines: number) {
    if (this.caps.has("draft/chathistory")) {
      this.sendRaw(formatLine("CHATHISTORY", "LATEST", target, "*", String(lines)));
    }
  }

  // ---- sending

  /** Sends what was typed into the active conversation, commands included. */
  submit(text: string) {
    const conv = this.active;
    const input = text.trim();
    if (!input) return;
    if (input.startsWith("/") && !input.startsWith("//")) {
      this.command(input.slice(1));
      return;
    }
    if (!conv) return;
    this.say(conv.name, input.startsWith("//") ? input.slice(1) : input, false);
  }

  private say(target: string, text: string, action: boolean) {
    if (!this.registered) return;
    const body = action ? `\x01ACTION ${text}\x01` : text;
    if (!this.sendRaw(formatLine("PRIVMSG", target, body))) return;
    // With echo-message the server sends it back, with its own time and id.
    if (!this.caps.has("echo-message")) {
      this.add(this.conversation(target)!, {
        id: `local-${nextId++}`,
        time: Date.now(),
        sender: this.nick,
        text,
        kind: action ? "action" : "message",
        ping: false,
      }, false);
    }
  }

  private command(input: string) {
    const [word, ...rest] = input.split(" ");
    const args = rest.join(" ").trim();
    const conv = this.active;
    switch (word.toLowerCase()) {
      case "me":
        if (conv && args) this.say(conv.name, args, true);
        return;
      case "msg":
      case "query": {
        const space = args.indexOf(" ");
        const nick = space < 0 ? args : args.slice(0, space);
        const text = space < 0 ? "" : args.slice(space + 1).trim();
        if (!nick) break;
        if (isChannel(nick)) {
          if (text) this.say(nick, text, false);
          return;
        }
        this.openPrivate(nick);
        if (text) this.say(nick, text, false);
        return;
      }
      case "join":
        if (args) {
          this.join(args.split(" ")[0]);
          return;
        }
        break;
      case "part":
      case "leave": {
        const target = args.split(" ")[0] || conv?.name || "";
        if (isChannel(target)) {
          this.wantedChannels.delete(keyOf(target));
          this.sendRaw(formatLine("PART", target, "Leaving"));
          return;
        }
        if (conv && !conv.channel) {
          this.hide(conv.key);
          return;
        }
        break;
      }
    }
    this.info("Commands: /me <action>, /msg <name> <text>, /join <#channel>, /part (leaves the channel for every connection of your account, desktop included).", "info");
  }

  /** A line from this page, not from anybody in the chat. */
  private info(text: string, kind: "info" | "error") {
    const conv = this.active;
    if (!conv) return;
    this.add(conv, { id: `info-${nextId++}`, time: Date.now(), sender: "", text, kind, ping: false }, false);
  }

  // ---- receiving

  private add(conv: Conversation, message: ChatMessage, live: boolean) {
    conv.messages.push(message);
    if (conv.messages.length > MAX_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_MESSAGES);
    conv.messagesVersion++;
    if (live && message.sender && keyOf(message.sender) !== keyOf(this.nick)) {
      const reading = conv.key === this.activeKey && document.visibilityState === "visible";
      if (!reading) {
        conv.unread++;
        if (message.ping || !conv.channel) conv.mentions++;
      }
      // A new private message brings its hidden tab back.
      if (!conv.channel && conv.hidden) conv.hidden = false;
    }
    if (live) this.catchUp(conv);
    this.changed();
  }

  private mentionsMe(text: string) {
    if (!this.nick) return false;
    const escaped = this.nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`, "i").test(text);
  }

  private historyRoot(line: IrcLine): string | undefined {
    const batch = line.tags.batch;
    return batch ? this.batchRoots.get(batch) : undefined;
  }

  private handle(line: IrcLine) {
    const p = line.params;
    const fromMe = Boolean(this.nick) && keyOf(line.source) === keyOf(this.nick);

    switch (line.command) {
      case "PING":
        this.sendRaw(formatLine("PONG", p[0] ?? ""));
        return;
      case "PONG":
        return;
      case "CAP":
        this.handleCap(line);
        return;
      case "AUTHENTICATE":
        if (p[0] === "+" && this.session) {
          this.sendRaw(formatLine("AUTHENTICATE", saslPlain(this.session.user.name, `token:${this.session.chatToken}`)));
        }
        return;
      case "903": {
        const nick = this.session?.user.name ?? "";
        this.nick = nick;
        this.sendRaw("CAP END");
        this.sendRaw(formatLine("NICK", nick));
        this.sendRaw(formatLine("USER", nick, "0", "*", nick));
        return;
      }
      case "904":
      case "905": {
        // A chat token can be refused when it has run out: fetch a new one
        // once, then give up rather than loop.
        const token = this.session?.chatToken;
        const ws = this.ws;
        this.ws = null;
        ws?.close();
        if (!this.authRetried) {
          this.authRetried = true;
          void this.open(token);
        } else {
          this.fail("FAF chat refused your login. Try logging out and in again.");
        }
        return;
      }
      case "433":
        this.nick = `${this.nick}_`;
        this.sendRaw(formatLine("NICK", this.nick));
        return;
      case "001":
        this.registered = true;
        this.nick = p[0] ?? this.nick;
        this.status = "connected";
        this.problem = "";
        this.attempt = 0;
        this.authRetried = false;
        for (const key of this.wantedChannels) {
          const conv = this.conversations.get(key);
          this.sendRaw(formatLine("JOIN", conv ? conv.name : key));
        }
        // Private conversations open from before a reconnect catch up.
        for (const conv of this.conversations.values()) {
          conv.historyAsked = false;
          this.catchUp(conv);
        }
        this.changed();
        return;
      case "005":
        for (const token of p.slice(1, -1)) {
          const [name, value = ""] = token.split("=");
          if (name === "PREFIX") {
            const match = /^\(([^)]*)\)(.*)$/.exec(value);
            if (match && match[1].length === match[2].length) {
              this.prefixModes = {};
              [...match[1]].forEach((mode, i) => (this.prefixModes[mode] = match[2][i]));
              this.prefixOrder = match[2];
            }
          } else if (name === "CHANMODES") {
            const [a = "", b = "", c = ""] = value.split(",");
            this.paramModes = { always: a + b + Object.keys(this.prefixModes).join(""), whenSet: c };
          }
        }
        return;
      case "BATCH":
        this.handleBatch(line);
        return;
      case "JOIN": {
        if (this.historyRoot(line)) return;
        const channel = p[0];
        if (!channel) return;
        if (fromMe) {
          const conv = this.conversation(channel)!;
          if (this.pendingSelect === conv.key) {
            this.pendingSelect = "";
            this.select(conv.key);
          }
          // Also after a reconnect: what was missed meanwhile. Repeats are dropped by id.
          this.requestHistory(channel, CHANNEL_HISTORY);
          this.changed();
          return;
        }
        const conv = this.conversation(channel, false);
        if (conv) {
          conv.users.set(keyOf(line.source), { name: line.source, prefix: "" });
          conv.usersVersion++;
          this.changed();
        }
        return;
      }
      case "PART":
      case "KICK": {
        if (this.historyRoot(line)) return;
        const channel = p[0];
        const who = line.command === "KICK" ? p[1] : line.source;
        const conv = channel ? this.conversation(channel, false) : undefined;
        if (!conv || !who) return;
        if (keyOf(who) === keyOf(this.nick)) {
          this.wantedChannels.delete(conv.key);
          if (line.command === "KICK") {
            conv.users.clear();
            conv.usersVersion++;
            this.add(conv, {
              id: `kick-${nextId++}`,
              time: Date.now(),
              sender: "",
              text: `You were removed from ${conv.name} by ${line.source}${p[2] ? `: ${stripFormatting(p[2])}` : ""}`,
              kind: "error",
              ping: false,
            }, false);
          } else {
            this.conversations.delete(conv.key);
            if (this.activeKey === conv.key) this.activeKey = this.visibleConversations()[0]?.key ?? "";
            this.changed();
          }
          return;
        }
        if (conv.users.delete(keyOf(who))) {
          conv.usersVersion++;
          this.changed();
        }
        return;
      }
      case "QUIT": {
        if (this.historyRoot(line)) return;
        const key = keyOf(line.source);
        for (const conv of this.conversations.values()) {
          if (conv.users.delete(key)) conv.usersVersion++;
        }
        this.changed();
        return;
      }
      case "NICK": {
        if (this.historyRoot(line)) return;
        const next = p[0];
        if (!next) return;
        if (fromMe) this.nick = next;
        for (const conv of this.conversations.values()) {
          const user = conv.users.get(keyOf(line.source));
          if (user) {
            conv.users.delete(keyOf(line.source));
            conv.users.set(keyOf(next), { ...user, name: next });
            conv.usersVersion++;
          }
        }
        this.changed();
        return;
      }
      case "MODE":
        if (!this.historyRoot(line)) this.handleMode(line);
        return;
      case "332":
      case "TOPIC": {
        if (this.historyRoot(line)) return;
        const channel = line.command === "332" ? p[1] : p[0];
        const conv = channel ? this.conversation(channel, false) : undefined;
        if (conv) {
          conv.topic = stripFormatting(p[p.length - 1] ?? "");
          this.changed();
        }
        return;
      }
      case "353": {
        const channel = p[2];
        if (!channel) return;
        const list = this.pendingNames.get(keyOf(channel)) ?? [];
        for (const entry of (p[3] ?? "").split(" ")) {
          if (!entry) continue;
          let i = 0;
          while (i < entry.length && this.prefixOrder.includes(entry[i])) i++;
          const name = entry.slice(i).split("!")[0];
          if (name) list.push({ name, prefix: entry.slice(0, i) });
        }
        this.pendingNames.set(keyOf(channel), list);
        return;
      }
      case "366": {
        const channel = p[1];
        if (!channel) return;
        const list = this.pendingNames.get(keyOf(channel)) ?? [];
        this.pendingNames.delete(keyOf(channel));
        const conv = this.conversation(channel, false);
        if (conv) {
          conv.users = new Map(list.map((user) => [keyOf(user.name), user]));
          conv.usersVersion++;
          this.changed();
        }
        return;
      }
      case "PRIVMSG":
      case "NOTICE":
        this.handleMessage(line, fromMe);
        return;
      case "ERROR":
        this.problem = stripFormatting(p[p.length - 1] ?? "");
        return;
      case "FAIL":
        this.info(stripFormatting(p[p.length - 1] ?? "The chat server refused that."), "error");
        return;
      default:
        // Errors the visitor caused: no such nick, cannot join, cannot send.
        if (/^[45]\d\d$/.test(line.command) && this.registered) {
          this.info(stripFormatting(p[p.length - 1] ?? line.command), "error");
        }
    }
  }

  private handleCap(line: IrcLine) {
    const sub = line.params[1];
    const list = line.params[line.params.length - 1] ?? "";
    if (sub === "LS") {
      for (const cap of list.split(" ")) if (cap) this.offeredCaps.add(cap.split("=")[0]);
      if (line.params[2] === "*") return;
      if (!this.offeredCaps.has("sasl")) {
        this.fail("The chat server does not offer a login.");
        return;
      }
      this.sendRaw(formatLine("CAP", "REQ", WANTED_CAPS.filter((cap) => this.offeredCaps.has(cap)).join(" ")));
    } else if (sub === "ACK") {
      for (const cap of list.split(" ")) if (cap) this.caps.add(cap.replace(/^-/, ""));
      this.sendRaw("AUTHENTICATE PLAIN");
    } else if (sub === "NAK") {
      // An optional capability must not cost the connection: ask for the login alone.
      if (this.caps.has("sasl")) return;
      this.sendRaw(formatLine("CAP", "REQ", "sasl"));
    }
  }

  private handleBatch(line: IrcLine) {
    const ref = line.params[0] ?? "";
    if (ref.startsWith("+")) {
      const id = ref.slice(1);
      const outer = line.tags.batch ? this.batchRoots.get(line.tags.batch) : undefined;
      const history = (line.params[1] ?? "").includes("chathistory");
      const root = outer ?? (history ? id : undefined);
      if (root) {
        this.batchRoots.set(id, root);
        if (root === id) this.historyHeld.set(id, { target: line.params[2] ?? "", lines: [] });
      }
    } else if (ref.startsWith("-")) {
      const id = ref.slice(1);
      const root = this.batchRoots.get(id);
      this.batchRoots.delete(id);
      if (root !== id) return;
      const held = this.historyHeld.get(id);
      this.historyHeld.delete(id);
      if (!held) return;
      const byConversation = new Map<string, ChatMessage[]>();
      for (const { conversation, message } of held.lines) {
        const list = byConversation.get(conversation) ?? [];
        list.push(message);
        byConversation.set(conversation, list);
      }
      for (const [name, messages] of byConversation) this.mergeHistory(this.conversation(name)!, messages);
      this.changed();
    }
  }

  /** History goes in front of what arrived live, in time order, without repeats. */
  private mergeHistory(conv: Conversation, history: ChatMessage[]) {
    conv.historyAsked = true;
    const seen = new Set(conv.messages.map((m) => m.id));
    const merged = [...history.filter((m) => !seen.has(m.id)), ...conv.messages];
    merged.sort((a, b) => a.time - b.time);
    conv.messages = merged.slice(-MAX_MESSAGES);
    conv.messagesVersion++;
  }

  private handleMode(line: IrcLine) {
    const [target, modes = "", ...args] = line.params;
    if (!target || !isChannel(target)) return;
    const conv = this.conversation(target, false);
    if (!conv) return;
    let adding = true;
    let arg = 0;
    let touched = false;
    for (const mode of modes) {
      if (mode === "+" || mode === "-") {
        adding = mode === "+";
        continue;
      }
      const symbol = this.prefixModes[mode];
      const takesArg = this.paramModes.always.includes(mode) || (adding && this.paramModes.whenSet.includes(mode));
      const value = takesArg ? args[arg++] : undefined;
      if (!symbol || !value) continue;
      const user = conv.users.get(keyOf(value));
      if (!user) continue;
      const set = new Set(user.prefix);
      if (adding) set.add(symbol);
      else set.delete(symbol);
      user.prefix = [...this.prefixOrder].filter((s) => set.has(s)).join("");
      touched = true;
    }
    if (touched) {
      conv.usersVersion++;
      this.changed();
    }
  }

  private handleMessage(line: IrcLine, fromMe: boolean) {
    const [target, raw = ""] = line.params;
    if (!target || !line.source) return;
    // Server notices before and during login are not conversation.
    if (!this.registered && line.command === "NOTICE") return;
    if (line.source.includes(".") && !isChannel(target)) return;

    const action = ctcpAction(raw);
    if (action === null && isCtcp(raw)) return;
    const text = stripFormatting(action ?? raw);
    const root = this.historyRoot(line);

    let conversation: string;
    if (isChannel(target)) conversation = target;
    else if (root) conversation = this.historyHeld.get(root)?.target || (fromMe ? target : line.source);
    else conversation = fromMe ? target : line.source;

    const parsed = line.tags.time ? Date.parse(line.tags.time) : NaN;
    const message: ChatMessage = {
      id: line.tags.msgid ? `m-${line.tags.msgid}` : `l-${nextId++}`,
      time: Number.isFinite(parsed) ? parsed : Date.now(),
      sender: line.source,
      text,
      kind: action !== null ? "action" : line.command === "NOTICE" ? "notice" : "message",
      ping: !fromMe && this.mentionsMe(text),
    };

    if (root) {
      this.historyHeld.get(root)?.lines.push({ conversation, message });
      return;
    }
    const conv = this.conversation(conversation)!;
    if (conv.messages.some((m) => m.id === message.id)) return;
    this.add(conv, message, true);
  }
}

export const chat = new ChatClient();
