// Moving to another tab from inside one, e.g. "Recent replays" on a player
// card. The App listens for popstate, so this is the same as using the back
// and forward buttons, and the address bar shows where you are.

export function go(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
