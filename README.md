# faf-web

A view-only FAF website in the design of the FAF Rust client, usable on phones.

Tabs: News, Play (open lobbies), Replays, Maps, Mods, Leaderboard, Tournaments, Events, Changelog, Units, Links.

## How it works

```
browser  ──►  faf-web (server.js)  ──►  api.faforever.com            maps, mods, replays, leaderboards (service login)
                                    ──►  www.faforever.com           leaderboards without the login (public JSON)
                                    ──►  lobby.faforever.com/games    open lobbies
                                    ──►  tournaments.faforever.com    tournaments
                                    ──►  raw.githubusercontent.com   events calendar
```

News, Changelog and Units are FAF's own pages, shown in a frame.

- The website runs entirely in the visitor's browser.
- `server.js` serves the built site from `public/` and proxies a fixed allowlist of read-only upstreams (`lib/upstreams.js`).
- Every visitor shares one cached copy of each response, so FAF's servers see one client, not one per visitor.
- The proxy never forwards a visitor's cookies or credentials, and only allows GET.
- Open lobbies come from the lobby server's public `GET /games` endpoint. Until that endpoint is live, the Play tab says so.
- Leaderboards come from FAF's API when the service login is set up, otherwise from faforever.com's public JSON (`/leaderboards/<board>.json`), which the server pages and searches. faforever.com is behind Cloudflare and may refuse a server's request; the log line then shows `"server":"cloudflare"`, and the tab says so.
- Replays can be downloaded by ID with no login at all: `replay.faforever.com/<id>` redirects to the API's public replay download.
- Replay downloads link straight to `replay.faforever.com/<id>`, which needs no login.

## Service login (Maps, Mods, Replays)

FAF's API only answers requests that carry a token; there are no anonymous listings. faf-web gets its token the way faforever.com does, through an OAuth `client_credentials` client of its own (`lib/faftoken.js`).

1. A FAF admin creates the client (gitops-stack `apps/ory-hydra/values.yaml`, "FAF Web (public)") and gives you its secret.
2. In Dockhand, set two environment variables on the stack:
   - `FAF_API_CLIENT_ID`: the client id from values.yaml
   - `FAF_API_CLIENT_SECRET`: the secret
3. Redeploy. `GET /healthz` shows `"serviceLogin": true`.

Without these variables, those three tabs say the login isn't set up, and everything else works. The token never leaves the server: it is only attached to requests to api.faforever.com.

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

1. Paste `docker-compose.yml` into a Dockhand stack. It clones this repo and runs `node server.js`. There is no volume. The only secret is the optional service login, set as stack environment variables (see above), never in the file.
2. Point an Nginx Proxy Manager host at `<host>:8098`, with **Cache Assets OFF**.
3. Check the log for `listening`. `GET /healthz` reports the state.

With `AUTO_UPDATE=1`, the site redeploys itself within a minute of a push to `main`. A new revision is cloned, syntax-checked and tested first. A failing one is logged as `UPDATE REJECTED`, and the old version keeps serving. The container's `restart: unless-stopped` is what restarts it, so keep that policy.

## Credits and licences

- `web/src/ds/` and `web/public/fonts`, `web/public/assets/faflogo.svg` come from the [FAF Rust client](https://github.com/FAForeverRustClient/FAForeverRustClient) at commit `ed3121e9` (MIT).
- Geist and Geist Mono fonts: Vercel, SIL Open Font License 1.1.
- The server and proxy come from the earlier faf-web (MIT).
