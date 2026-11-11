# faf-web

A view-only FAF website in the design of the FAF Rust client, usable on phones.

Tabs: Play (open lobbies), News, Maps, Mods, Leaderboard, Tournaments, Events, Changelog, Units, Links.

## How it works

```
browser  ──►  faf-web (server.js)  ──►  api.faforever.com            maps, mods, leaderboard
                                    ──►  lobby.faforever.com/games    open lobbies
                                    ──►  tournaments.doodlepros.com   tournaments
                                    ──►  raw.githubusercontent.com   events calendar
```

- The website runs entirely in the visitor's browser.
- `server.js` serves the built site from `public/` and proxies a fixed allowlist of read-only upstreams (`lib/upstreams.js`).
- Every visitor shares one cached copy of each response, so FAF's servers see one client, not one per visitor.
- The proxy forwards no credentials and only allows GET.
- Open lobbies come from the lobby server's public `GET /games` endpoint. Until that endpoint is live, the Play tab says so.

## Layout

| Path | What |
|---|---|
| `server.js`, `lib/` | Server: static files, the proxy, auto-update. No runtime dependencies. |
| `webtest.js` | Server tests (`npm test`). No network needed. |
| `web/` | Website source: React + TypeScript + Vite. |
| `web/src/ds/` | The Rust client's design system: tokens, fonts, shell and nav styles, icons. |
| `public/` | The **built** website, committed so the server needs no build step. |

## Changing the website

```
cd web
npm install
npm run build      # type-checks, then writes the site into ../public
```

Commit `web/` and `public/` together. For live editing, run `node server.js` in the repo root and `npm run dev` in `web/`; the dev server forwards `/api` to it.

## Deploying on Dockhand

1. Paste `docker-compose.yml` into a Dockhand stack. It clones this repo and runs `node server.js`. There are no secrets and no volume.
2. Point an Nginx Proxy Manager host at `<host>:8098`, with **Cache Assets OFF**.
3. Check the log for `listening`. `GET /healthz` reports the state.

With `AUTO_UPDATE=1`, the site redeploys itself within a minute of a push to `main`. A new revision is cloned, syntax-checked and tested first. A failing one is logged as `UPDATE REJECTED`, and the old version keeps serving. The container's `restart: unless-stopped` is what restarts it, so keep that policy.

## Credits and licences

- `web/src/ds/` and `web/public/fonts`, `web/public/assets/faflogo.svg` come from the [FAF Rust client](https://github.com/FAForeverRustClient/FAForeverRustClient) at commit `ed3121e9` (MIT).
- Geist and Geist Mono fonts: Vercel, SIL Open Font License 1.1.
- The server and proxy come from the earlier faf-web (MIT).
