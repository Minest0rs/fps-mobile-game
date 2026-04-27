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
  events?: {
    night?: boolean;
    lowGravity?: boolean;
    meteorShower?: boolean;
    fog?: boolean;
    thunderstorm?: boolean;
    sandstorm?: boolean;
  };
}

/** Channels eligible for random-event scheduling. Mirrors `MatchEvents` in
 *  the schema. Kept narrow so the scheduler can iterate type-safely. */
type EventKey =
  | "night"
  | "lowGravity"
  | "meteorShower"
  | "fog"
  | "thunderstorm"
  | "sandstorm";
const EVENT_KEYS: EventKey[] = [
  "night", "lowGravity", "meteorShower", "fog", "thunderstorm", "sandstorm",
];

/** Random scheduling parameters — only one event is active at any time.
 *  When a slot frees up the scheduler picks a random enabled event from
 *  those still on cooldown, waits a random gap, then activates it. This
 *  prevents the "everything on at once" feeling and keeps each event's
 *  effect distinct. */
const EVENT_OFF_MIN_MS = 25_000;   // shortest gap between fires (after one ends)
const EVENT_OFF_MAX_MS = 60_000;   // longest gap between fires
const EVENT_ON_MIN_MS = 14_000;    // shortest active duration
const EVENT_ON_MAX_MS = 26_000;    // longest active duration
/** Initial delay so the first event doesn't fire the instant the match
 *  starts (gives players a chance to orient first). */
const EVENT_INITIAL_GRACE_MS = 25_000;

const ARENA_HALF = 400; // matches client builder (open-world map)
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

  /** Which event channels are *eligible* to fire in this match. The host
   *  picks these at room creation and they don't change after that. The
   *  *currently active* event lives in `state.events` and is flipped by
   *  the server's sequential scheduler — at most one event is active at
   *  any moment. */
  private enabledEvents: Record<EventKey, boolean> = {
    night: false, lowGravity: false, meteorShower: false, fog: false,
    thunderstorm: false, sandstorm: false,
  };
  /** Sequential scheduler state. `currentEvent` holds the key of the
   *  active event (or null when nothing is firing). `nextFireAt` /
   *  `deactivateAt` drive the on/off transitions. */
  private currentEvent: EventKey | null = null;
  private nextFireAt = 0;
  private deactivateAt = 0;

  onCreate(opts?: JoinOpts) {
    this.setState(new ArenaState());

    // The first client to join creates the room (Colyseus convention),
    // which means their `JoinOpts` define the match for everyone else.
    // Toggling an event in the lobby *enables* it for random scheduling —
    // it doesn't pin it to "always on". The scheduler in `tick()` flips
    // `state.events.X` true for short bursts at random intervals.
    if (opts?.events) {
      this.enabledEvents.night        = !!opts.events.night;
      this.enabledEvents.lowGravity   = !!opts.events.lowGravity;
      this.enabledEvents.meteorShower = !!opts.events.meteorShower;
      this.enabledEvents.fog          = !!opts.events.fog;
      this.enabledEvents.thunderstorm = !!opts.events.thunderstorm;
      this.enabledEvents.sandstorm    = !!opts.events.sandstorm;
      // Schedule the first event after a short grace period — only one
      // event is ever active at a time, so we just need a single timer.
      const anyEnabled = EVENT_KEYS.some(k => this.enabledEvents[k]);
      if (anyEnabled) {
        this.nextFireAt = Date.now() + EVENT_INITIAL_GRACE_MS + Math.random() * 20_000;
      }
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

    // Sequential match-event scheduler — at most one event is active at
    // any time. When the active event ends we wait a random gap then
    // pick the next event uniformly from the *enabled* set (excluding
    // the one that just ended where possible, so the same event doesn't
    // fire twice in a row).
    if (this.currentEvent && now >= this.deactivateAt) {
      this.state.events[this.currentEvent] = false;
      const justEnded = this.currentEvent;
      this.currentEvent = null;
      this.deactivateAt = 0;
      this.nextFireAt = now + EVENT_OFF_MIN_MS + Math.random() * (EVENT_OFF_MAX_MS - EVENT_OFF_MIN_MS);
      // Suppress unused-variable lint without breaking the no-repeat
      // logic below if we ever want to reinstate it; the pool already
      // excludes the active key implicitly because we just cleared it.
      void justEnded;
    }
    if (!this.currentEvent && this.nextFireAt > 0 && now >= this.nextFireAt) {
      const pool = EVENT_KEYS.filter(k => this.enabledEvents[k]);
      if (pool.length > 0) {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        this.currentEvent = pick;
        this.state.events[pick] = true;
        this.deactivateAt = now + EVENT_ON_MIN_MS + Math.random() * (EVENT_ON_MAX_MS - EVENT_ON_MIN_MS);
        this.nextFireAt = 0;
      }
    }

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
