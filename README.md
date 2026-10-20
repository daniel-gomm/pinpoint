# Pinpoint

A GeoGuessr-style party game with your own photos. Upload pictures, mark where each was taken, and let friends guess on a map. Each round is scored separately and totals add up to a final leaderboard.

## Run

```sh
docker compose up --build
```

Open http://localhost:8080 (set `PORT=9000 docker compose up` for another port). The invite link in the lobby uses this computer's LAN address, so it works for everyone on the same network even when you opened the page as `localhost`. Set `PUBLIC_URL=http://my-host:8080` to override the address in invite links.

- `server`: Node/Express + Socket.IO. It runs on the host network (port `SERVER_PORT`, default 3737) so it can detect the LAN address. Picture sets are stored in `./data`.
- `web`: nginx serving the built frontend and proxying `/api` and `/socket.io` to the server.

## How to play

1. **Picture sets**: create a set, drop in photos. If a photo has GPS data the location is filled in automatically. Otherwise select it and click the map where it was taken (you can drag pins and add captions). Photos are re-encoded in the browser before upload, which strips EXIF so players can't read the location from the file.
2. **Host a game**: pick a set, the number of rounds and seconds per round. Share the four-letter code or invite link.
3. **Rounds**: everyone sees the photo, places a pin and locks it in. A round ends when the timer runs out or everyone has guessed (the host can also end it early). A pin that was placed but not locked in still counts when time runs out. The screen gets a red frame for the last 15 seconds. The reveal shows all guesses, distances and points; the host starts the next round.
4. **Final**: podium, per-round breakdown and a map recap of every round.

Refreshing the page or losing connection is fine: players rejoin automatically.

## Scoring

`points = round(5000 × e^(−10 × distance / mapSize))`, with 5000 for anything within 25 m.
`mapSize` defaults to the distance between the two farthest pictures in the set, so a set of photos from one city is scored as strictly as a world-wide set. The host can override it under "Scoring" when creating a game.

## Development

```sh
cd server && npm install && DATA_DIR=../data npm run dev   # :3000
cd web && npm install && npm run dev                      # :5173, proxies to :3000
cd server && npm test
```

Games live in memory on the server; restarting the server ends running games but keeps picture sets.
