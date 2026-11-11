import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface Props {
  icon: IconName;
  /** Why there is nothing here, in one line. */
  title: string;
  /** What to do about it. Omitted where there is nothing useful to suggest. */
  hint?: ReactNode;
  /**
   * Dashed placeholder framing, for a state that stands in for a results grid
   * rather than filling a pane. The vaults use it; a browser pane does not.
   */
  bordered?: boolean;
  className?: string;
  /** An action, so the state is not a dead end. */
  children?: ReactNode;
}

/**
 * The "nothing here" state: icon, heading, hint, optionally an action.
 *
 * Every list, grid and vault in the client needs one, and each feature used to
 * draw its own. Three implementations existed (`vault-empty`, `play-empty-state`
 * and `coop-games-empty`) and had drifted to different icon sizes, heading
 * levels, text colours, hint sizes and minimum heights, so the same situation
 * looked like a different kind of thing in each tab.
 */
export function EmptyState({ icon, title, hint, bordered = false, className, children }: Props) {
  const classes = ["empty-state", bordered ? "is-bordered" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <Icon name={icon} size={24} />
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
}
