import { Room, Client } from "@colyseus/core";
import { ArenaState, Player, KillEntry } from "./state.js";
import { getWeapon } from "./weapons.js";
import { spawnBots, tickBots, type BotDifficulty } from "./bots.js";

interface MoveMsg { x: number; y: number; z: number; yaw: number; pitch: number; }
interface ShootMsg { targetId?: string; }
interface JoinOpts {
  name?: string;
  skin?: string;
  weapon?: string;
  bots?: { enabled?: boolean; count?: number; difficulty?: BotDifficulty };
  events?: { night?: boolean; lowGravity?: boolean; meteorShower?: boolean; fog?: boolean };
}

const ARENA_HALF = 300; // matches client builder (open-world map)
const SPAWN_RADIUS = 60; // cluster fresh spawns near the centre
const RESPAWN_DELAY_MS = 3000;
const MAX_FEED = 6;
/** Tick rate for the simulation loop (state diff broadcast is decoupled). */
const TICK_MS = 100;

export class ArenaRoom extends Room<ArenaState> {
  maxClients = 16;

  /** Difficulty profile applied to all bots in this match. */
  private botDifficulty: BotDifficulty = "normal";
  /** Whether bots are active in this match (so we know to run tickBots). */
  private botsEnabled = false;

  onCreate(opts?: JoinOpts) {
    this.setState(new ArenaState());

    // The first client to join creates the room (Colyseus convention),
    // which means their `JoinOpts` define the match for everyone else.
    if (opts?.events) {
      this.state.events.night = !!opts.events.night;
      this.state.events.lowGravity = !!opts.events.lowGravity;
      this.state.events.meteorShower = !!opts.events.meteorShower;
      this.state.events.fog = !!opts.events.fog;
    }
    if (opts?.bots?.enabled && (opts.bots.count ?? 0) > 0) {
      this.botsEnabled = true;
      this.botDifficulty = (opts.bots.difficulty as BotDifficulty) ?? "normal";
      const count = Math.max(0, Math.min(8, Math.floor(opts.bots.count ?? 0)));
      spawnBots(this.state, count, this.botDifficulty, () => this.spawnPoint());
    }

    this.onMessage<MoveMsg>("move", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hp <= 0) return;
      // Server is authoritative on position. Guard NaN/Infinity from the
      // wire so a bad client can't poison everyone's render path.
      p.x = clamp(safeNum(msg.x), -ARENA_HALF, ARENA_HALF);
      p.z = clamp(safeNum(msg.z), -ARENA_HALF, ARENA_HALF);
      p.y = clamp(safeNum(msg.y), -10, 100);
      p.yaw = safeNum(msg.yaw);
      p.pitch = clamp(safeNum(msg.pitch), -1.4, 1.4);
    });

    this.onMessage<ShootMsg>("shoot", (client, msg) => {
      const attacker = this.state.players.get(client.sessionId);
      if (!attacker || attacker.hp <= 0) return;
      const w = getWeapon(attacker.weapon);

      const now = Date.now();
      // Allow up to `pellets` shoot messages per fireRate window — clients
      // with a shotgun emit one message per pellet so all of them can hit
      // different targets in the same trigger pull.
      if (now - attacker.lastShotAt < w.fireRateMs - 5) {
        // Within the same cluster: reset the cooldown only when we've
        // exhausted our pellet budget.
        attacker.shotsInBurst += 1;
        if (attacker.shotsInBurst > w.pellets) return;
      } else {
        attacker.lastShotAt = now;
        attacker.shotsInBurst = 1;
      }

      if (!msg?.targetId) return;
      const victim = this.state.players.get(msg.targetId);
      if (!victim || victim.id === attacker.id || victim.hp <= 0) return;

      victim.hp = Math.max(0, victim.hp - w.damage);
      if (victim.hp === 0) this.handleKill(attacker, victim);
    });

    this.setSimulationInterval(() => this.tick(), TICK_MS);
  }

  onJoin(client: Client, options: JoinOpts) {
    const p = new Player();
    p.id = client.sessionId;
    p.name = (options?.name ?? "Player").slice(0, 20) || "Player";
    p.skin = options?.skin ?? "neon";
    p.weapon = options?.weapon ?? "rifle";
    p.isBot = false;
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
    entry.attackerId = attacker.id;
    entry.victimId = victim.id;
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
    const dt = TICK_MS / 1000;

    // Respawn dead humans (bots are handled inside tickBots).
    this.state.players.forEach((p) => {
      if (p.isBot) return;
      if (p.hp <= 0 && p.respawnAt > 0 && now >= p.respawnAt) {
        const sp = this.spawnPoint();
        p.x = sp.x; p.y = sp.y; p.z = sp.z;
        p.hp = 100;
        p.respawnAt = 0;
      }
    });

    // Bot AI + bot shots resolve here.
    if (this.botsEnabled) {
      const shots = tickBots(this.state, this.botDifficulty, dt, ARENA_HALF, () => this.spawnPoint());
      for (const s of shots) {
        const a = this.state.players.get(s.attackerId);
        const v = this.state.players.get(s.victimId);
        if (!a || !v || v.hp <= 0) continue;
        v.hp = Math.max(0, v.hp - s.damage);
        if (v.hp === 0) this.handleKill(a, v);
      }
    }
  }

  private spawnPoint() {
    // Pick a point at least PILLAR_RADIUS away from origin so we never
    // spawn inside the central pillar.
    const PILLAR_RADIUS = 3.0;
    for (let i = 0; i < 20; i++) {
      const x = (Math.random() * 2 - 1) * SPAWN_RADIUS;
      const z = (Math.random() * 2 - 1) * SPAWN_RADIUS;
      // Avoid the river corridor (z near 0) and the centre pillar.
      if (Math.abs(z) < 14) continue;
      if (x * x + z * z >= PILLAR_RADIUS * PILLAR_RADIUS) return { x, y: 5, z };
    }
    // Fallback (very unlikely): place on a circle just outside the pillar.
    const angle = Math.random() * Math.PI * 2;
    return {
      x: Math.cos(angle) * 8,
      y: 5,
      z: Math.sin(angle) * 8 + 16, // pushed off the river
    };
  }

}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
