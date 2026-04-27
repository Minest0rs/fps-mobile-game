import { Client, Room } from "colyseus.js";

export interface PlayerState {
  id: string;
  name: string;
  skin: string;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  hp: number;
  kills: number; deaths: number;
}

export interface KillEntryState {
  attacker: string;
  victim: string;
  at: number;
}

export interface ArenaStateLike {
  players: { forEach(cb: (p: PlayerState, key: string) => void): void;
             onAdd(cb: (p: PlayerState, key: string) => void): void;
             onRemove(cb: (p: PlayerState, key: string) => void): void;
             get(key: string): PlayerState | undefined; };
  killFeed: { onAdd(cb: (k: KillEntryState, idx: number) => void): void;
              forEach(cb: (k: KillEntryState) => void): void; };
  tick: number;
}

/** URL of the Colyseus server.
 *  - Build override: VITE_SERVER_URL (e.g. wss://my-server.example.com)
 *  - Local dev: ws://<host>:2567
 *  - Production (server serves both HTTP and WS on same port): same origin */
function resolveServerUrl(): string {
  const env = (import.meta as any).env?.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // If we're served from a non-standard dev port, assume separate game server on 2567.
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return `${proto}//${location.hostname}:2567`;
  }
  return `${proto}//${location.host}`;
}

export const SERVER_URL = resolveServerUrl();

export async function joinArena(name: string, skin: string): Promise<Room<ArenaStateLike>> {
  const client = new Client(SERVER_URL);
  const room = await client.joinOrCreate<ArenaStateLike>("arena", { name, skin });
  return room;
}
