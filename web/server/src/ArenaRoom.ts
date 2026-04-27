import { Room, Client } from "@colyseus/core";
import { ArenaState, Player, KillEntry } from "./state.js";

interface MoveMsg { x: number; y: number; z: number; yaw: number; pitch: number; }
interface ShootMsg { targetId?: string; }
interface JoinOpts { name?: string; skin?: string; }

const ARENA_HALF = 19; // matches client builder
const RESPAWN_DELAY_MS = 3000;
const SHOT_COOLDOWN_MS = 110; // ~9 shots/s
const SHOT_DAMAGE = 22;
const MAX_FEED = 6;

export class ArenaRoom extends Room<ArenaState> {
  maxClients = 16;

  onCreate() {
    this.setState(new ArenaState());

    this.onMessage<MoveMsg>("move", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0) return;
      // Clamp into arena bounds — server is authoritative on position.
      p.x = clamp(msg.x, -ARENA_HALF, ARENA_HALF);
      p.z = clamp(msg.z, -ARENA_HALF, ARENA_HALF);
      p.y = clamp(msg.y, 0, 4);
      p.yaw = msg.yaw;
      p.pitch = clamp(msg.pitch, -1.4, 1.4);
    });

    this.onMessage<ShootMsg>("shoot", (client, msg) => {
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker || attacker.hp <= 0) return;

      const now = Date.now();
      if (now - attacker.lastShotAt < SHOT_COOLDOWN_MS) return;
      attacker.lastShotAt = now;

      if (!msg?.targetId) return;
      const victim = this.state.players.get(msg.targetId);
      if (!victim || victim.id === attacker.id || victim.hp <= 0) return;

      victim.hp = Math.max(0, victim.hp - SHOT_DAMAGE);
      if (victim.hp === 0) this.handleKill(attacker, victim);
    });

    this.setSimulationInterval(() => this.tick(), 100);
  }

  onJoin(client: Client, options: JoinOpts) {
    const p = new Player();
    p.id = client.sessionId;
    p.name = (options?.name ?? "Player").slice(0, 20) || "Player";
    p.skin = options?.skin ?? "neon";
    const sp = this.spawnPoint();
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    p.hp = 100;
    this.state.players.set(client.sessionId, p);
    console.log(`[arena] join ${p.name} (${client.sessionId}); ${this.state.players.size} players`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`[arena] leave ${client.sessionId}; ${this.state.players.size} players`);
  }

  private handleKill(attacker: Player, victim: Player) {
    attacker.kills += 1;
    victim.deaths += 1;
    victim.respawnAt = Date.now() + RESPAWN_DELAY_MS;

    const entry = new KillEntry();
    entry.attacker = attacker.name;
    entry.victim = victim.name;
    entry.at = Date.now();
    this.state.killFeed.push(entry);
    while (this.state.killFeed.length > MAX_FEED) this.state.killFeed.shift();

    this.broadcast("kill", { attacker: attacker.id, victim: victim.id });
  }

  private tick() {
    this.state.tick += 1;
    const now = Date.now();
    this.state.players.forEach((p) => {
      if (p.hp <= 0 && p.respawnAt > 0 && now >= p.respawnAt) {
        const sp = this.spawnPoint();
        p.x = sp.x; p.y = sp.y; p.z = sp.z;
        p.hp = 100;
        p.respawnAt = 0;
      }
    });
  }

  private spawnPoint() {
    const r = ARENA_HALF * 0.6;
    return {
      x: (Math.random() * 2 - 1) * r,
      y: 1.6,
      z: (Math.random() * 2 - 1) * r,
    };
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
