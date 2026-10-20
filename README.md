# Pinpoint

A GeoGuessr-style party game with your own photos. Players guess **where** a picture was taken (on a map or your own floor plan), **when** it was taken (on a timeline), or **put several pictures in order**. Each round is scored separately and totals add up to a final leaderboard.

## Run

```sh
docker compose up --build
```

Open http://localhost:8080 (`PORT=9000 docker compose up` for another port). The lobby shows an invite link and a QR code with this computer's LAN address, so phones on the same Wi-Fi can join even when you opened the page as `localhost`. Set `PUBLIC_URL=http://my-host:8080` to override the address in invite links.

- `server`: Node/Express + Socket.IO. It runs on the host network (port `SERVER_PORT`, default 3737) so it can detect the LAN address. Picture sets and running games are stored in `./data`.
- `web`: nginx serving the built frontend and proxying `/api` and `/socket.io` to the server.

**macOS / Windows (Docker Desktop):** host networking can't see your LAN address there. Use the override and pass your address:

```sh
PUBLIC_URL=http://192.168.1.20:8080 docker compose -f docker-compose.yml -f docker-compose.desktop.yml up --build
```

Games survive a server restart (`docker compose restart`): players reconnect automatically and a running round keeps its remaining time.

## Picture sets

- Create a set and drop in photos (JPEG, PNG, WebP, iPhone HEIC). Location (GPS) and date/time are read from the camera data when present. Otherwise select a picture, click the map, and fill in "Taken on".
- **Bulk editing:** Ctrl- or Shift-click several pictures to set one date for all, place them all with one click, clear fields or remove them.
- **Custom map:** use your own image (floor plan, campus map) instead of the world map. Distances are shown in meters if you enter the real width, otherwise as a percentage of the map width.
- **Export / import:** download a set as a zip and import it elsewhere.
- The server re-encodes every upload (rotation, max 2400 px, JPEG), which strips all metadata, so players can't read the answer from the file.

## Hosting a game

| Setting | Options |
|---|---|
| What players guess | **Place** (pin on the map), **Date** (timeline; precision: day + time, day, month or year), **Order** (sort 3–6 pictures from oldest to newest) |
| Pictures | From a **picture set**, or **players bring them**: everyone uploads their own in the lobby and sits out the rounds with their own pictures (they get the average of the others' scores for that round) |
| Scoring | **Placement** (default): a point for every player you were closer than, ties count half, so one big miss costs at most last place. **Points**: up to 5,000 per round by distance. Placement totals are tie-broken by points. |
| Shared screen | The host's device becomes a **presenter**: it shows the pictures, timer and results (e.g. on a TV) and doesn't play. |

Rounds end when the timer runs out, when everyone has locked in, or when the host ends them. A pick that wasn't locked in still counts. The screen gets a red frame for the last 15 seconds. After the final scores, the host can **play again with everyone** in the same lobby; pictures not played yet come first.

## Scoring details

Points: `round(5000 × e^(−10 × distance / scale))`, 5,000 for a near-perfect guess (25 m; 15 minutes in date mode).

- **Place:** the scale is the largest distance between pictures in the set, ignoring outliers (a picture whose typical distance to the others is more than 3× the norm, like one holiday photo in a set from one city). The host can override it.
- **Date:** the same with hours. At day/month/year precision any guess in the right period is perfect, and misses count in whole periods. The timeline covers all of the set's dates with random padding on both ends (capped at today), so its edges don't reveal the oldest or newest picture.
- **Order:** 5,000 × the share of picture pairs in the right order.

## Development

```sh
npm install && (cd server && npm install) && (cd web && npm install)
cd server && DATA_DIR=../data npm run dev     # API on :3000
cd web && npm run dev                         # http://localhost:5173, proxies to :3000
```

Checks, from the repository root:

```sh
npm test         # server unit tests (game engine, scoring, images, sets)
npm run check    # type check of server and client (JSDoc + shared/protocol.js)
npx playwright install chromium   # once
npm run e2e      # browser tests: starts a throwaway server and Vite on ports 3999/5199
```

`HEIC_SAMPLE=/path/to/photo.heic npm test` also runs the HEIC conversion test. `CHROMIUM_PATH=/path/to/chrome npm run e2e` uses an existing Chromium instead of installing one.

Code layout: `server/src/modes.js` holds what differs per game mode on the server (validation, distance, scoring, answer), `server/src/game.js` the round flow, `web/src/modes/` the matching guessing and reveal UI, and `shared/protocol.js` the types of the messages between them.
