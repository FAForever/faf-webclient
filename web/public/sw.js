// The site's service worker. It does one thing: show "Match found" when the
// PC link sends a push (lib/link.js), and bring the site up when it is tapped.
// No caching and no offline mode: every page load still comes from the server.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title : "FAForever";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : "faf",
      renotify: true,
      icon: "/assets/icon-192.png",
      badge: "/assets/badge-96.png",
      vibrate: [200, 100, 200, 100, 200],
      data: { url: typeof data.url === "string" ? data.url : "/play" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const wanted = event.notification.data && event.notification.data.url;
  // Only a page of this site.
  const path = typeof wanted === "string" && wanted.startsWith("/") && !wanted.startsWith("//") ? wanted : "/play";
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
