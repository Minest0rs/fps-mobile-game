# Browser FPS — Three.js + Colyseus

A small 3D networked first-person shooter that runs in any modern browser
(desktop and mobile). The same Node server hosts the game state and serves
the static client, so a single deployment makes both halves available.

## Stack

| Concern        | Tech                                      |
|----------------|-------------------------------------------|
| 3D rendering   | [three](https://threejs.org/) ^0.169      |
| Multiplayer    | [Colyseus](https://colyseus.io/) 0.15.x   |
| Client build   | Vite 5 + TypeScript                       |
| Server runtime | Node 18+ + Express + Colyseus             |
| Persistence    | `localStorage` for level/XP/skin choice   |

## Layout

```
web/
├── client/      Vite + Three.js front-end
│   ├── src/
│   │   ├── game/      Scene, controller, input, shooting, avatars
│   │   ├── net/       Colyseus client wrapper
│   │   ├── ui/        HUD, kill feed, scoreboard, main menu
│   │   ├── profile.ts XP/level/skins persistence
│   │   ├── main.ts    Wires everything together
│   │   └── style.css
│   └── index.html
└── server/      Colyseus + Express server
    └── src/
        ├── ArenaRoom.ts  Room logic: join, move, shoot, kill, respawn
        ├── state.ts      Replicated schema
        └── index.ts      HTTP + WebSocket server, also serves client/dist
```

## Running locally

```bash
# from web/
npm install --workspaces --include-workspace-root

# build the client once, then start the server (which serves the client)
npm --workspace client run build
npm --workspace server run dev   # http://localhost:2567

# OR run client and server separately for hot-reload during development:
npm --workspace server run dev   # http://localhost:2567 (game server)
npm --workspace client run dev   # http://localhost:5173 (Vite)
# When using the Vite dev server, the client falls back to ws://localhost:2567
# automatically — see resolveServerUrl() in client/src/net/client.ts.
```

Then open <http://localhost:2567> in two tabs and play.

## Deployment

Only the **server** has to be reachable on the public Internet — it serves the
client too. Deploy `web/` to anything that runs Node and supports raw
WebSockets:

- **Fly.io / Railway / Render**: ship the `web/` directory, build command
  `npm install && npm --workspace client run build && npm --workspace server run build`,
  start command `npm --workspace server run start`, expose port `2567`.
- **Self-hosted VM**: run the server behind nginx/caddy with
  `proxy_pass http://localhost:2567` and `Connection: upgrade` headers.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:2567`
  (works because Cloudflare proxies `Upgrade: websocket` over HTTP/1.1).

When the client is served from a different origin than the game server, set
`VITE_SERVER_URL` at build time to the absolute `wss://` URL of the server:

```bash
VITE_SERVER_URL=wss://your-server.example.com \
  npm --workspace client run build
```

## Controls

| Action            | Desktop                         | Mobile                          |
|-------------------|---------------------------------|---------------------------------|
| Move              | `WASD` / arrow keys             | Left thumb on virtual joystick  |
| Look              | Mouse (pointer-locked)          | Right-side drag                 |
| Fire              | Left click                      | `FIRE` button (hold)            |
| Jump              | `Space`                         | `JUMP` button                   |
| Reload            | `R` (or auto on empty mag)      | Auto on empty mag               |
| Scoreboard        | `Tab` (toggle)                  | `SCORE` button (toggle)         |

## Server-authoritative model

The client predicts movement and renders shots locally for responsiveness,
but the server owns the truth:

- `move` messages are clamped into the arena bounds before being reflected
  back via the replicated `Player` schema.
- `shoot` messages name a target session id; the server applies a fixed
  damage value, enforces a per-player fire-rate cooldown, and rejects shots
  while the attacker is dead.
- Health, kills, deaths, kill-feed entries, and respawn timers all live in
  `ArenaState` so every client renders the same outcome.

The XP / level / skin selection is local-only (`localStorage`). This keeps the
multiplayer layer cheap and lets unlocks be tweaked without redeploying the
server.

## Where to extend

- `server/src/ArenaRoom.ts` — gameplay rules (damage, cooldowns, respawn)
- `server/src/state.ts` — anything you want replicated
- `client/src/game/scene.ts` — arena geometry / lighting
- `client/src/game/avatar.ts` — what remote players look like
- `client/src/profile.ts` — XP curve, skin definitions, unlock thresholds
