import { useEffect, useState, type ReactNode } from "react";
import { ApiError, getJson, getText } from "../api";
import { EmptyState } from "../ds/EmptyState";
import type { IconName } from "../ds/Icon";

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; status: number | null; code: string | null; message: string }
  | { state: "ready"; data: T };

/**
 * Fetch `path` and keep it fresh. `refreshMs` re-fetches on an interval while
 * the view is open; a failed refresh keeps the last good data on screen.
 */
export function useJson<T>(path: string | null, refreshMs?: number): Load<T> {
  return useLoad<T>(path, getJson as (path: string, signal: AbortSignal) => Promise<T>, refreshMs);
}

/** `useJson` for a text upstream. */
export function useText(path: string | null, refreshMs?: number): Load<string> {
  return useLoad(path, getText, refreshMs);
}

function useLoad<T>(path: string | null, get: (path: string, signal: AbortSignal) => Promise<T>, refreshMs?: number): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });

  useEffect(() => {
    if (!path) return;
    let alive = true;
    const controller = new AbortController();
    setLoad({ state: "loading" });

    const run = () =>
      get(path, controller.signal)
        .then((data) => alive && setLoad({ state: "ready", data }))
        .catch((error: unknown) => {
          if (!alive || controller.signal.aborted) return;
          setLoad((previous) =>
            previous.state === "ready"
              ? previous
              : {
                  state: "error",
                  status: error instanceof ApiError ? error.status : null,
                  code: error instanceof ApiError ? error.code : null,
                  message: error instanceof Error ? error.message : String(error),
                },
          );
        });

    run();
    const timer = refreshMs ? window.setInterval(run, refreshMs) : undefined;
    return () => {
      alive = false;
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [path, refreshMs]);

  return load;
}

export function ViewHeader({ title, description, actions }: { title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="web-view-header">
      <div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {actions && <div className="web-view-actions">{actions}</div>}
    </header>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="web-state muted" role="status">
      Loading {what}...
    </div>
  );
}

// Failures server.js explains with a code, and what to tell the visitor.
const EXPLAINED: Record<string, string> = {
  "service-login-missing": "FAF's API only answers logged-in requests, and this site's login to it isn't set up yet.",
  "service-login-failed": "This site's login to FAF's API was refused. Try again later.",
  "leaderboard-refused": "faforever.com refused this site's request. This tab will work once the site's login to FAF's API is set up.",
};

export function LoadFailed({ icon, what, status, code }: { icon: IconName; what: string; status: number | null; code?: string | null }) {
  if (code && EXPLAINED[code]) {
    return <EmptyState icon={icon} title={`Can't show ${what} yet`} hint={EXPLAINED[code]} bordered />;
  }
  return (
    <EmptyState
      icon={icon}
      title={`Couldn't load ${what}`}
      hint={status ? `The server answered ${status}. Try again in a minute.` : "Check your connection and try again."}
      bordered
    />
  );
}

/** Whether a CSS media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
