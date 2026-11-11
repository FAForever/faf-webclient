# FAF webclient

FAF's web client at **webclient.faforever.com**, in the design of the FAF Rust client and usable on phones. Everything is view-only and needs no account, except the Chat tab, which needs a FAF login.

Tabs: News, Chat, Play (open lobbies), Replays, Maps, Mods, Leaderboard, Tournaments, Events, Changelog, Units, Links.

## How it works

```
browser  ──►  webclient (server.js) ──►  api.faforever.com            maps, mods, replays, leaderboards (service login)
                                    ──►  www.faforever.com           leaderboards without the login (public JSON)
                                    ──►  lobby.faforever.com          open lobbies, live games, matchmaker queues
                                    ──►  tournaments.faforever.com    tournaments
                                    ──►  raw.githubusercontent.com   events calendar
                                    ──►  hydra / user.faforever.com   Chat tab login (relayed, see below)
browser  ──────────────────────────►  wss://chat.faforever.com     Chat tab, straight from the browser
```

News, Changelog and Units are FAF's own pages, shown in a frame.

- The website runs entirely in the visitor's browser.
- `server.js` serves the built site from `public/` and proxies a fixed allowlist of read-only upstreams (`lib/upstreams.js`).
- Every visitor shares one cached copy of each response, so FAF's servers see one client, not one per visitor.
- The proxy never forwards a visitor's cookies or credentials, and only allows GET.
- Open lobbies come from the lobby server's public `GET /games` endpoint (FAForever/server PR "Public endpoints for the game list and matchmaker queues", which also adds live games and `GET /matchmaker`). Until it is live, the Play tab says so.
- Leaderboards come from FAF's API when the service login is set up, otherwise from faforever.com's public JSON (`/leaderboards/<board>.json`), which the server pages and searches. faforever.com is behind Cloudflare and may refuse a server's request; the log line then shows `"server":"cloudflare"`, and the tab says so.
- Replays can be downloaded by ID with no login at all: `replay.faforever.com/<id>` redirects to the API's public replay download.
- FAF also runs a test copy at webclient.faforever.xyz. `FAF_BASE_DOMAIN=faforever.xyz` makes every host name above point at FAF's test servers instead (`lib/hosts.js`); the site gets the same setting from `/api/config`.

## Service login (Maps, Mods, Replays)

FAF's API only answers requests that carry a token; there are no anonymous listings. The server gets its token the way faforever.com does, through an OAuth `client_credentials` client of its own (`lib/faftoken.js`).

The client is "FAF Web (public)" in gitops-stack `apps/ory-hydra/values.yaml`. Its secret is kept in Infisical twice: `FAFWEB_M2M_SECRET` in `ory-hydra` (for Hydra) and `FAF_API_CLIENT_SECRET` in `faf-webclient` (for this site). The server reads two environment variables:

- `FAF_API_CLIENT_ID`: the client id
- `FAF_API_CLIENT_SECRET`: the secret

`GET /healthz` shows `"serviceLogin": true` when both are set.

Without these variables, those three tabs say the login isn't set up, and everything else works. The token never leaves the server: it is only attached to requests to api.faforever.com.

## Chat login

The Chat tab logs players in with their FAF account and connects them to FAF's chat (IRC over WebSocket), like the desktop clients do.

1. The browser sends the player to FAF's login page (Hydra, authorization code with PKCE). The client is FAF's public "FAF Web" client: no secret, scope `openid offline public_profile`, redirect `https://<your domain>/auth/callback`.
2. FAF sends the player back to `/auth/callback`. Hydra and FAF's user service answer no browser requests from other sites (no CORS), so `server.js` makes the next calls for the browser (`POST /api/auth/login`, `lib/userlogin.js`): code to tokens, then the player's chat token from `user.faforever.com`. The browser gets the player's name, the chat token and the refresh token. The access token stays on the server, and nothing is stored or logged there.
3. The browser connects to `wss://chat.faforever.com` itself, from the player's own address. A new chat token (24 hours) comes through `POST /api/auth/refresh`.

FAF's chat lets one account be connected several times, so the desktop client stays online. Both connections share their channels: closing a channel tab here only hides it, and `/part` leaves it everywhere.

The client is "FAF Web" in gitops-stack `apps/ory-hydra/values.yaml`. Its only redirect URI is `https://webclient.$BASE_DOMAIN/auth/callback`, so login works on FAF's own deployments and nowhere else. On a private test server, set `FAF_LOGIN_CLIENT_ID=off` and the Chat tab says login isn't available. `GET /healthz` shows `"chatLogin"`.

## Layout

| Path | What |
|---|---|
| `server.js`, `lib/` | Server: static files, the proxy, auto-update. No runtime dependencies. |
| `webtest.js` | Server tests (`npm test`). No network needed. |
| `web/` | Website source: React + TypeScript + Vite. |
| `web/src/ds/` | The Rust client's design system: tokens, fonts, shell and nav styles, icons. |
| `public/` | The **built** website, committed so a git clone runs without a build step. The image builds its own copy from `web/`. |
| `Dockerfile`, `.github/workflows/image.yml` | The image FAF runs, published on every push to `main`. |

## Changing the website

```
cd web
npm install
npm run build      # type-checks, then writes the site into ../public
```

Commit `web/` and `public/` together. For live editing, run `node server.js` in the repo root and `npm run dev` in `web/`; the dev server forwards `/api` to it.

## Releasing

Pushing to `main` is the release, the same setup as FAForever/faf-tournaments:

1. GitHub Actions (`.github/workflows/image.yml`) checks the server, runs `npm test`, builds the website, then builds the image and publishes it as `faforever/faf-webclient:latest` and `:<commit>`.
2. FAF's cluster (gitops-stack `apps/faf-webclient`) notices the new `latest` within two minutes and rolls it out (Keel).

A failing check publishes nothing, and the running version stays. To roll back, point `latest` at an earlier commit's image.

The cluster sets `FAF_BASE_DOMAIN`, `FAF_API_CLIENT_ID` and `FAF_LOGIN_CLIENT_ID` in `apps/faf-webclient/templates/config.yaml`. `FAF_API_CLIENT_SECRET` comes from the Infisical secret `faf-webclient`.

## A private test server on Dockhand

1. Paste `docker-compose.yml` into a Dockhand stack. It clones this repo and runs `node server.js`. There is no volume. The only secret is the optional service login, set as stack environment variables (see above), never in the file.
2. Point an Nginx Proxy Manager host at `<host>:8098`, with **Cache Assets OFF**.
3. Check the log for `listening`. `GET /healthz` reports the state.

With `AUTO_UPDATE=1`, the site redeploys itself within a minute of a push to `main`. A new revision is cloned, syntax-checked and tested first. A failing one is logged as `UPDATE REJECTED`, and the old version keeps serving. The container's `restart: unless-stopped` is what restarts it, so keep that policy.

## Credits and licences

- `web/src/ds/` and `web/public/fonts`, `web/public/assets/faflogo.svg` come from the [FAF Rust client](https://github.com/FAForeverRustClient/FAForeverRustClient) at commit `ed3121e9` (MIT).
- Geist and Geist Mono fonts: Vercel, SIL Open Font License 1.1.
- The server and proxy come from the earlier faf-web by Nuggets (MIT).
