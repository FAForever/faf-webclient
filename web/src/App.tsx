import { useEffect, useRef, useState, type ComponentType } from "react";
import { Icon, type IconName } from "./ds/Icon";
import { go } from "./nav";
import { ChangelogView } from "./changelog/ChangelogView";
import { EventsView } from "./events/EventsView";
import { NewsView } from "./news/NewsView";
import { ChatView } from "./views/ChatView";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { EmbedView, LinksView, TournamentsView } from "./views/ListViews";
import { LeaderboardView } from "./views/LeaderboardView";
import { PlayView } from "./views/PlayView";
import { ReplaysView } from "./views/ReplaysView";
import { VaultView } from "./views/VaultView";

interface TabDef {
  id: string;
  label: string;
  icon: IconName;
  Component: ComponentType;
  bottom?: boolean;
}

// Same order, labels and icons as the Rust client's sidebar (ui/src/features/nav/tabs.tsx),
// minus Training and Settings. Chat is the one tab that needs a login.
const TABS: TabDef[] = [
  { id: "news", label: "News", icon: "news", Component: NewsView },
  { id: "chat", label: "Chat", icon: "chat", Component: ChatView },
  { id: "play", label: "Play", icon: "play", Component: PlayView },
  { id: "replays", label: "Replays", icon: "replays", Component: ReplaysView },
  { id: "maps", label: "Maps", icon: "maps", Component: () => <VaultView kind="map" /> },
  { id: "mods", label: "Mods", icon: "mods", Component: () => <VaultView kind="mod" /> },
  { id: "leaderboard", label: "Leaderboard", icon: "leaderboard", Component: LeaderboardView },
  { id: "tournaments", label: "Tournaments", icon: "trophy", Component: TournamentsView },
  { id: "events", label: "Events", icon: "calendar", Component: EventsView },
  { id: "changelog", label: "Changelog", icon: "changelog", Component: ChangelogView },
  {
    id: "units",
    label: "Units",
    icon: "units",
    Component: () => <EmbedView title="Units" description="Stats for every unit." url="https://unitdb.faforever.com/" />,
  },
  { id: "links", label: "Links", icon: "external", Component: LinksView, bottom: true },
];

const DEFAULT_TAB = "play";

function tabFromPath(): string {
  // FAF's login page sends the visitor back here; the Chat tab finishes the login.
  if (window.location.pathname === "/auth/callback") return "chat";
  // The first part of the path: /changelog/3837 is the Changelog tab.
  const id = window.location.pathname.split("/").filter(Boolean)[0] ?? "";
  return TABS.some((tab) => tab.id === id) ? id : DEFAULT_TAB;
}

function BrandMark({ size }: { size: number }) {
  // Painted as a mask so the single-colour wordmark takes the theme's ink, as in the Rust client.
  const mask = `url("/assets/faflogo.svg") center / contain no-repeat`;
  return <span aria-hidden="true" style={{ display: "inline-block", width: size, height: size, mask, WebkitMask: mask, background: "var(--color-brand-mark, currentColor)" }} />;
}

export function App() {
  const [tab, setTab] = useState(tabFromPath);
  const [menuOpen, setMenuOpen] = useState(false);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const select = (id: string) => {
    setMenuOpen(false);
    // The same tab again still goes to its start: /changelog/3837 back to the list.
    if (window.location.pathname === `/${id}`) return;
    go(`/${id}`);
    contentRef.current?.scrollTo({ top: 0 });
  };

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const Active = active.Component;

  const renderTab = (t: TabDef) => (
    <button
      key={t.id}
      className={t.id === tab ? "tab tab-active" : "tab"}
      onClick={() => select(t.id)}
      aria-current={t.id === tab ? "page" : undefined}
      title={t.label}
    >
      <Icon name={t.icon} size={17} />
      <span>{t.label}</span>
    </button>
  );

  return (
    <div className={`app-shell web-shell${menuOpen ? " is-menu-open" : ""}`}>
      <header className="web-topbar">
        <button className="web-menu-button" onClick={() => setMenuOpen((open) => !open)} aria-label="Menu" aria-expanded={menuOpen}>
          <Icon name={menuOpen ? "close" : "list"} size={20} />
        </button>
        <span className="web-topbar-title">
          <Icon name={active.icon} size={17} /> {active.label}
        </span>
        <BrandMark size={28} />
      </header>

      <div className="web-scrim" onClick={() => setMenuOpen(false)} />

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark size={38} />
          </span>
          <span className="brand-copy">
            <strong>FAForever</strong>
            <small>Web</small>
          </span>
        </div>

        <nav className="tabbar" aria-label="Main">
          <div className="nav-group">{TABS.filter((t) => !t.bottom).map(renderTab)}</div>
          <div className="nav-spacer" />
          <div className="nav-group">{TABS.filter((t) => t.bottom).map(renderTab)}</div>
        </nav>
      </aside>

      <main className="workspace">
        <section ref={contentRef} className={`content content-tab-${active.id}`} aria-label={active.label} tabIndex={-1}>
          <div className={`content-inner content-${active.id}`}>
            {/* Keyed by tab, so switching tabs also clears a crashed one. */}
            <ErrorBoundary key={active.id}>
              <Active />
            </ErrorBoundary>
          </div>
        </section>
      </main>
    </div>
  );
}
