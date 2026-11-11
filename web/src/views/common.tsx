import { useEffect, useState, type ReactNode } from "react";
import { ApiError, getJson } from "../api";
import { EmptyState } from "../ds/EmptyState";
import type { IconName } from "../ds/Icon";

export type Load<T> =
  | { state: "loading" }
  | { state: "error"; status: number | null; message: string }
  | { state: "ready"; data: T };

/**
 * Fetch `path` and keep it fresh. `refreshMs` re-fetches on an interval while
 * the view is open; a failed refresh keeps the last good data on screen.
 */
export function useJson<T>(path: string | null, refreshMs?: number): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });

  useEffect(() => {
    if (!path) return;
    let alive = true;
    const controller = new AbortController();
    setLoad({ state: "loading" });

    const run = () =>
      getJson<T>(path, controller.signal)
        .then((data) => alive && setLoad({ state: "ready", data }))
        .catch((error: unknown) => {
          if (!alive || controller.signal.aborted) return;
          setLoad((previous) =>
            previous.state === "ready"
              ? previous
              : {
                  state: "error",
                  status: error instanceof ApiError ? error.status : null,
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

export function LoadFailed({ icon, what, status }: { icon: IconName; what: string; status: number | null }) {
  return (
    <EmptyState
      icon={icon}
      title={`Couldn't load ${what}`}
      hint={status ? `The server answered ${status}. Try again in a minute.` : "Check your connection and try again."}
      bordered
    />
  );
}
