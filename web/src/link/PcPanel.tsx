// "Your PC" on the Play tab: the FAF Rust client on the player's own PC, seen
// and steered through the PC link (link.ts). Start or stop a matchmaker search,
// get told when a match is found, see who of your friends is online.
//
// Nothing here plays anything: the game always runs on the PC.

import { useEffect, useMemo, useState } from "react";
import { AuthError, beginLogin, siteConfig } from "../auth";
import { Icon } from "../ds/Icon";
import { sendCommand, useLink } from "./link";
import { queueName, queueTitle, type PcFriend, type PcQueue, type PcState } from "./protocol";
import { disablePush, enablePush, pushEnabled, pushSupport } from "./push";
import "./link.css";

const QUEUES_KEY = "faf-web.searchQueues";

function rememberedQueues(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(QUEUES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((q): q is string => typeof q === "string") : [];
  } catch {
    return [];
  }
}

function rememberQueues(queues: string[]) {
  try {
    window.localStorage.setItem(QUEUES_KEY, JSON.stringify(queues));
  } catch {
    // Not remembered.
  }
}

function list(names: string[], queues: PcQueue[]): string {
  const titles = names.map((name) => queueName(name, queues));
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** "in 0:42", until the queue next pops. */
function popsIn(popsAt: string | null, now: number): string | null {
  if (!popsAt) return null;
  const seconds = Math.round((new Date(popsAt).getTime() - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const GAME_STATUS: Record<NonNullable<PcState["game"]>["status"], string> = {
  joining: "Joining a game",
  preparing: "Getting the game ready",
  launched: "The game is starting",
  lobby: "In a game lobby",
  playing: "Playing",
};

function statusLine(state: PcState): { text: string; tone: "idle" | "busy" | "found" } {
  const { status, queues } = state.matchmaking;
  const names = list(queues, state.queues);
  switch (status) {
    case "preparing":
      return { text: `Getting the maps ready to search ${names || "the queue"}...`, tone: "busy" };
    case "searching":
      return { text: `Searching ${names || "the queue"}.`, tone: "busy" };
    case "matchFound":
      return { text: "Match found. Your game is starting on your PC.", tone: "found" };
    case "launching":
      return { text: "Your game is starting on your PC.", tone: "found" };
    case "cancelled":
      return { text: "The search was cancelled.", tone: "idle" };
    default:
      return { text: "Not searching.", tone: "idle" };
  }
}

function Matchmaking({ state }: { state: PcState }) {
  const now = useNow(1000);
  const [picked, setPicked] = useState<string[]>(rememberedQueues);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const { status } = state.matchmaking;
  const active = status === "preparing" || status === "searching";
  const starting = status === "matchFound" || status === "launching";
  const selected = active ? state.matchmaking.queues : picked.filter((name) => state.queues.some((q) => q.name === name));
  const partySize = Math.max(1, state.party.members.length);
  const me = state.player?.id ?? null;
  const notLeader = partySize > 1 && state.party.ownerId !== null && state.party.ownerId !== me;
  const inGame = state.game !== null && !starting;
  const offline = state.lobby !== "connected";
  const locked = busy || active || starting || notLeader || inGame || offline;

  const toggle = (name: string) => {
    const next = selected.includes(name) ? selected.filter((q) => q !== name) : [...selected, name];
    setPicked(next);
    rememberQueues(next);
  };

  const run = async (start: boolean) => {
    setBusy(true);
    setProblem("");
    const result = await sendCommand(start ? { action: "startSearch", queues: selected } : { action: "stopSearch" });
    setBusy(false);
    if (!result.ok) setProblem(result.error ?? "Your PC refused.");
  };

  const line = statusLine(state);

  return (
    <section className="pc-section" aria-labelledby="pc-matchmaking">
      <h3 id="pc-matchmaking" className="pc-section-title">
        Matchmaking
      </h3>
      {state.queues.length === 0 ? (
        <p className="muted pc-note">{offline ? "The client on your PC is not connected to FAF right now." : "No queues are open right now."}</p>
      ) : (
        <div className="pc-queues" role="group" aria-label="Queues">
          {state.queues.map((queue) => {
            const on = selected.includes(queue.name);
            const tooSmall = queue.teamSize < partySize;
            const pops = popsIn(queue.popsAt, now);
            return (
              <button
                key={queue.name}
                type="button"
                className={`pc-queue${on ? " is-on" : ""}`}
                aria-pressed={on}
                disabled={locked || (tooSmall && !on)}
                title={tooSmall ? "Your party is too large for this queue." : undefined}
                onClick={() => toggle(queue.name)}
              >
                <span className="pc-queue-title">
                  {on && <Icon name="check" size={14} />}
                  {queueTitle(queue)}
                </span>
                <span className="pc-queue-meta muted">
                  <span>
                    <Icon name="users" size={13} /> {queue.playersInQueue} searching
                  </span>
                  {pops && (
                    <span>
                      <Icon name="clock" size={13} /> {pops}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className={`pc-status is-${line.tone}`} role="status">
        {line.tone === "busy" && <span className="pc-spinner" aria-hidden="true" />}
        {line.tone === "found" && <Icon name="bell" size={16} />}
        <span>{line.text}</span>
      </div>
      {notLeader && <p className="muted pc-note">You are in a party: its leader starts the search.</p>}
      {inGame && state.game && (
        <p className="muted pc-note">
          {GAME_STATUS[state.game.status]}
          {state.game.title ? `: ${state.game.title}` : ""}
        </p>
      )}

      <div className="pc-actions">
        {active ? (
          <button type="button" className="web-button" disabled={busy} onClick={() => void run(false)}>
            <Icon name="close" size={15} /> Stop search
          </button>
        ) : (
          <button
            type="button"
            className="web-button web-button-primary"
            disabled={locked || selected.length === 0}
            onClick={() => void run(true)}
          >
            <Icon name="play" size={15} /> Start search
          </button>
        )}
        <NotifyToggle />
      </div>
      {problem && (
        <p className="pc-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

function NotifyToggle() {
  const support = pushSupport();
  const [on, setOn] = useState(pushEnabled);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (support === "unsupported") return <p className="muted pc-note">This browser cannot notify you. The page still shows it while it is open.</p>;
  if (support === "needs-install") {
    return <p className="muted pc-note">To be notified on an iPhone, add this site to your Home Screen (Share, then Add to Home Screen) and open it from there.</p>;
  }
  if (support === "denied") return <p className="muted pc-note">Notifications are blocked for this site in your browser settings.</p>;

  const change = async (next: boolean) => {
    setBusy(true);
    setProblem("");
    try {
      if (next) {
        const key = (await siteConfig()).link?.pushKey;
        if (!key) throw new Error("This site cannot send notifications.");
        await enablePush(key);
      } else {
        await disablePush();
      }
      setOn(next);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Notifications could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="pc-notify">
      <label className="pc-check">
        <input type="checkbox" checked={on} disabled={busy} onChange={(event) => void change(event.target.checked)} />
        Notify this device when a match is found
      </label>
      {problem && <span className="pc-problem">{problem}</span>}
    </span>
  );
}

function friendStatus(friend: PcFriend): string {
  if (!friend.online) return "Offline";
  if (!friend.game) return "Online";
  return `${friend.game.status === "playing" ? "Playing" : "In a lobby"}: ${friend.game.title}`;
}

function Friends({ friends }: { friends: PcFriend[] }) {
  const [showOffline, setShowOffline] = useState(false);
  const online = friends.filter((f) => f.online);
  const offline = friends.filter((f) => !f.online);
  const shown = showOffline ? [...online, ...offline] : online;

  return (
    <section className="pc-section" aria-labelledby="pc-friends">
      <h3 id="pc-friends" className="pc-section-title">
        Friends <span className="muted">{online.length} online</span>
      </h3>
      {friends.length === 0 ? (
        <p className="muted pc-note">Nobody on your friends list yet. Add friends in the client on your PC.</p>
      ) : (
        <>
          {shown.length > 0 && (
            <ul className="pc-friends">
              {shown.map((friend) => (
                <li key={friend.name} className={`pc-friend${friend.online ? " is-online" : ""}${friend.game ? " is-busy" : ""}`}>
                  <span className="pc-friend-dot" aria-hidden="true" />
                  <span className="pc-friend-name">{friend.name}</span>
                  <span className="pc-friend-status muted">{friendStatus(friend)}</span>
                </li>
              ))}
            </ul>
          )}
          {offline.length > 0 && (
            <button type="button" className="web-button pc-more" onClick={() => setShowOffline((v) => !v)}>
              <Icon name={showOffline ? "chevronUp" : "chevronDown"} size={14} />
              {showOffline ? "Hide offline friends" : `${offline.length} offline`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function LoginPrompt() {
  const [problem, setProblem] = useState("");
  return (
    <div className="pc-empty">
      <p className="muted">Log in to start a search on your PC from here, and get told when a match is found.</p>
      <button
        type="button"
        className="web-button web-button-primary"
        onClick={() =>
          beginLogin("/play").catch((err: unknown) => setProblem(err instanceof AuthError || err instanceof Error ? err.message : "Could not start the login."))
        }
      >
        <Icon name="user" size={15} /> Log in with FAF
      </button>
      {problem && <p className="pc-problem">{problem}</p>}
    </div>
  );
}

export function PcPanel() {
  const link = useLink();
  const [open, setOpen] = useState(true);

  const pill = useMemo(() => {
    if (link.status === "ready" && link.pc.connected) return { text: link.pc.device ? `Connected: ${link.pc.device}` : "Connected", tone: "ok" };
    if (link.status === "ready") return { text: "Not connected", tone: "off" };
    if (link.status === "connecting") return { text: "Connecting...", tone: "off" };
    if (link.status === "failed") return { text: "Unavailable", tone: "warn" };
    return null;
  }, [link.status, link.pc]);

  if (link.status === "off") return null;

  return (
    <section className={`web-card pc-panel${open ? "" : " is-closed"}`} aria-labelledby="pc-title">
      <header className="pc-head">
        <h2 id="pc-title" className="web-card-title">
          <Icon name="monitor" size={17} /> Your PC
        </h2>
        {pill && <span className={`pc-pill is-${pill.tone}`}>{pill.text}</span>}
        <button type="button" className="web-icon-button pc-collapse" aria-expanded={open} aria-label={open ? "Hide" : "Show"} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? "chevronUp" : "chevronDown"} size={16} />
        </button>
      </header>

      {open && (
        <div className="pc-body">
          {link.status === "logged-out" && <LoginPrompt />}
          {link.status === "failed" && <p className="pc-problem">{link.problem}</p>}
          {link.status === "connecting" && <p className="muted pc-note">Connecting to this site...</p>}
          {link.status === "ready" && !link.pc.connected && (
            <div className="pc-empty">
              <p>The FAF client on your PC is not connected.</p>
              <p className="muted">
                Start the FAF client on your PC, log in with the same account, then open <strong>Settings</strong>,{" "}
                <strong>Account</strong>, and turn on <strong>Allow control from the web client</strong>. It connects by itself
                from then on.
              </p>
            </div>
          )}
          {link.status === "ready" && link.pc.connected && !link.state && <p className="muted pc-note">Waiting for your PC...</p>}
          {link.status === "ready" && link.pc.connected && link.state && (
            <div className="pc-columns">
              <Matchmaking state={link.state} />
              <Friends friends={link.state.friends} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
