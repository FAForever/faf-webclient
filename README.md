# FAF webclient

FAF's web client at **webclient.faforever.com**, in the design of the FAF Rust client and usable on phones. Everything is view-only and needs no account, except the Chat tab and "Your PC" on the Play tab, which need a FAF login.

Tabs: News, Chat, Play (open lobbies), Replays, Maps, Mods, Leaderboard, Tournaments, Events, Changelog, Units, Links.

## How it works

```
browser  ──►  webclient (server.js) ──►  api.faforever.com            maps, mods, replays, leaderboards (service login)
                                    ──►  www.faforever.com           news hub, leaderboards without the login (public JSON)
                                    ──►  lobby.faforever.com          open lobbies, live games, matchmaker queues
                                    ──►  tournaments.faforever.com    tournaments
                                    ──►  raw.githubusercontent.com   events calendar, patch notes (FAForever/fa docs/_posts)
                                    ──►  faforever.github.io         list of game patches (FAForever/fa changelog page)
                                    ──►  hydra / user.faforever.com   Chat tab login (relayed, see below)
browser  ──────────────────────────►  wss://chat.faforever.com     Chat tab, straight from the browser
browser  ──►  webclient /api/link  ◄──  FAF Rust client on the player's PC   "Your PC" (see below)
```

- News: the articles of faforever.com/newshub, from the website's own `/data/newshub.json`, as plain text (no HTML from it reaches the page).
- Events: the community catalogue (`FAForeverRustClient/events`, `calendar.json`, weekly and monthly repeats expanded), tournaments, and released patches, in the visitor's time zone, as in the Rust client. An entry can be saved to the visitor's calendar app as an `.ics` file.
- Changelog: the patch list from the changelog page and each patch's Markdown, read the way the Rust client reads them (unit icons, `old -> new` changes, issue links). `/changelog/<patch>` links straight to a patch. The changelog page is third-party HTML, so the server hands it to the browser as `text/plain` and it is only ever parsed, never shown.
- Maps and Mods: a card opens its details: the large picture, facts, description, every version with its download, and the reviews (`/data/{map|mod}/{id}/versions?include=reviews,reviews.player`, as the Rust client reads them). "Replays on this map" opens the Replays tab searched by the map's name (`/replays?map=<name>`).
- Units is FAF's unit database, shown in a frame.

- The website runs entirely in the visitor's browser.
- `server.js` serves the built site from `public/` and proxies a fixed allowlist of read-only upstreams (`lib/upstreams.js`).
- Every visitor shares one cached copy of each response, so FAF's servers see one client, not one per visitor.
- The proxy never forwards a visitor's cookies or credentials, and only allows GET.
- Open lobbies come from the lobby server's public `GET /games` endpoint (FAForever/server PR "Public endpoints for the game list and matchmaker queues", which also adds live games and `GET /matchmaker`). Until it is live, the Play tab says so.
- Leaderboards come from FAF's API when the service login is set up, otherwise from faforever.com's public JSON (`/leaderboards/<board>.json`), which the server pages and searches. faforever.com is behind Cloudflare and may refuse a server's request; the log line then shows `"server":"cloudflare"`, and the tab says so.
- Replays can be downloaded by ID with no login at all: `replay.faforever.com/<id>` redirects to the API's public replay download.
- Inside FAF's cluster the server calls FAF's services by their internal names (`faf-api:8010`, `ory-hydra:4444`, `faf-user-service:8080`, `faf-website:3000`, `faf-tournaments:8090`), because Cloudflare's anti-spam checks refuse a server's requests to the public addresses. It knows it is in the cluster from `KUBERNETES_SERVICE_HOST`; `FAF_API_URL`, `FAF_HYDRA_URL`, `FAF_USER_SERVICE_URL`, `FAF_WEBSITE_URL`, `FAF_TOURNAMENTS_URL` and `FAF_LOBBY_URL` override single addresses. The browser keeps using the public addresses. `GET /healthz` shows `"inCluster"`.
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

Who is online: FAF's chat server keeps every account in its channels for 30 days after it last connected (Ergo `always-on: mandatory`) and marks it away while nobody is connected as it (`auto-away: mandatory`), so a channel's name list holds thousands of people who are not there. The Chat tab asks the server who is away (`WHO` with WHOX, then `away-notify`) and lists only the rest. Avatars and clan tags come from FAF's API, a batch of names at a time (`web/src/chat/profiles.ts`). Country flags, friends and who is in a game are not in the API: they come from faf-player-service and faf-game-service over RabbitMQ, which this site does not read. With the PC link connected, friends are known from the Rust client: they get their own group and colour, as there.

The client is "FAF Web" in gitops-stack `apps/ory-hydra/values.yaml`. Its only redirect URI is `https://webclient.$BASE_DOMAIN/auth/callback`, so login works on FAF's own deployments and nowhere else. On a private test server, set `FAF_LOGIN_CLIENT_ID=off` and the Chat tab says login isn't available. `GET /healthz` shows `"chatLogin"`.

## Your PC (the PC link)

A logged-in player can steer the FAF Rust client on their own PC from the Play tab: start or stop a matchmaker search, join an open lobby, see their friends, and get "Match found" on their phone. Nothing is played in the browser; the game runs on the PC. Only the Rust client takes part, and only once the player turns on Settings > Account > "Allow control from the web client" there (off by default).

```
phone browser ──wss──►  webclient /api/link  ◄──wss──  Rust client on the PC
              ◄─push─  (Web Push, from the server, when the PC reports a match)
```

- Both ends connect out to this site, so nothing on the PC is opened to the internet. The server pairs a browser and a PC only when they belong to the same FAF account (`lib/link.js`).
- The PC proves its account with its own FAF access token. Hydra signs those as JWTs; the server checks the signature against Hydra's published keys (`/.well-known/jwks.json`, `lib/jwt.js`), the issuer, the expiry, and that the token was issued to the Rust client's OAuth client (`03c2132b-...`, or the Python client's `95ecec08-...`, which the Rust client signed in with before it had its own and still renews remembered logins under). A page in a browser cannot pose as the PC: browsers always send an `Origin`, and the PC side refuses one.
- The browser proves its account with a ticket the server signs at login and with each chat token renewal (`linkTicket`, 25 hours). Its WebSocket must come from this site's own origin.
- The browser can ask for four things and nothing else: start a search in named queues, stop searching, join a game by id (with its password), and send the state again. The server checks each, rate-limits them (30 a minute), and the Rust client checks them again before acting.
- One PC per account (a second one takes over and the first is told why), at most 8 browsers per account. Nothing is stored: the PC's latest state is kept in memory for browsers that connect later.
- "Match found" reaches a phone with the page closed through Web Push (RFC 8291 encryption, RFC 8292 VAPID, `lib/webpush.js`), and only to the browsers' own push services (Google, Mozilla, Apple, Microsoft). The key pair is made when the server starts; browsers sign up again whenever they connect, so no key needs configuring. An iPhone needs the site added to its Home Screen for notifications (iOS 16.4 and later). TMM games start about a minute after the match is found, so be quick.
- The link assumes one server process (the deployment runs one replica).

Settings, all optional: `FAF_LINK=off` turns it off. `FAF_LINK_PUSH=off` turns off notifications only. `FAF_LINK_VAPID_KEY` (a PKCS#8 PEM EC P-256 key) keeps one push key across restarts. `FAF_LINK_SECRET` keeps tickets valid across restarts. `FAF_LINK_CLIENT_IDS` (comma-separated) replaces the OAuth client ids whose tokens may act as the PC. `GET /healthz` shows `"link"`: how many PCs and browsers are connected.

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

- `web/src/ds/`, `web/public/fonts`, `web/public/assets/faflogo.svg` and `mapgen-placeholder.png` (scaled down), and the layouts and styles of the Events, Changelog and Replays tabs come from the [FAF Rust client](https://github.com/FAForeverRustClient/FAForeverRustClient) at commit `ed3121e9` (MIT).
- Geist and Geist Mono fonts: Vercel, SIL Open Font License 1.1.
- The server and proxy come from the earlier faf-web by Nuggets (MIT).
