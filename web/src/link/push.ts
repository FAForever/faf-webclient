// "Match found" on the phone, with the page closed: Web Push.
//
// The browser subscribes at its vendor's push service with this site's public
// key (from /api/config) and hands the subscription to the site, which keeps
// it in memory and posts there when the PC reports a match (lib/link.js,
// lib/webpush.js). public/sw.js shows the notification.
//
// The server makes a new key and forgets every subscription when it restarts,
// so the page signs up again each time the link connects, and swaps the
// subscription when the key has changed.
//
// iPhone and iPad: only a page added to the Home Screen may use push (iOS 16.4
// and later). In a Safari tab there is no PushManager at all.

import { AuthError, freshLinkTicket } from "../auth";

const PREF_KEY = "faf-web.matchPush";

export type PushSupport = "available" | "needs-install" | "denied" | "unsupported";

function readPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === "on";
  } catch {
    return false;
  }
}

function writePref(on: boolean) {
  try {
    if (on) window.localStorage.setItem(PREF_KEY, "on");
    else window.localStorage.removeItem(PREF_KEY);
  } catch {
    // Not remembered: asked again next time.
  }
}

function isAppleMobile(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isInstalled(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!capable) return isAppleMobile() && !isInstalled() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "available";
}

/** The player turned notifications on here, and the browser still allows them. */
export function pushEnabled(): boolean {
  return readPref() && pushSupport() === "available" && Notification.permission === "granted";
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "===".slice((base64.length + 3) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const bytes = new Uint8Array(a);
  return bytes.length === b.length && bytes.every((value, i) => value === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

async function post(body: Record<string, unknown>): Promise<void> {
  const send = async (ticket: string) =>
    fetch("/api/link/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...body, ticket }),
    });
  let ticket = await freshLinkTicket();
  let res = await send(ticket);
  if (res.status === 401) {
    // The server restarted since the ticket was handed out.
    ticket = await freshLinkTicket(ticket);
    res = await send(ticket);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `The site refused (${res.status}).`);
  }
}

/** Subscribe (or reuse the subscription) and give it to the site. */
async function register(pushKey: string): Promise<void> {
  const reg = await registration();
  const key = keyBytes(pushKey);
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    // Made for the key before the server's last restart.
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  if (!subscription) subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await post({ subscription: subscription.toJSON() });
}

/** Turn notifications on, asking the browser for permission. Throws with a reason to show. */
export async function enablePush(pushKey: string): Promise<void> {
  if (pushSupport() !== "available") throw new Error("This browser cannot show notifications from this site.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications were not allowed.");
  try {
    await register(pushKey);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new Error(err instanceof Error ? err.message : "Notifications could not be set up.");
  }
  writePref(true);
}

export async function disablePush(): Promise<void> {
  writePref(false);
  if (pushSupport() !== "available") return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  await post({ remove: true, endpoint: subscription.endpoint }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => false);
}

/** After each connection: sign up again, since the server may have restarted. */
export async function renewPush(pushKey: string | null): Promise<void> {
  if (!pushKey || !pushEnabled()) return;
  await register(pushKey).catch(() => undefined);
}

/** A notification from the page itself, for a page that is open but not looked at. */
export async function notifyHere(title: string, body: string): Promise<void> {
  if (!("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration("/");
  // Same tag as the push from the server, so the two end up as one.
  await reg?.showNotification(title, { body, tag: "faf-match-found", icon: "/assets/icon-192.png", data: { url: "/play" } }).catch(() => undefined);
}
