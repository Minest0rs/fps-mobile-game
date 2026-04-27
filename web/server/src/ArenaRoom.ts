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

/** Channels eligible for random-event scheduling. Mirrors `MatchEvents` in
 *  the schema. Kept narrow so the scheduler can iterate type-safely. */
type EventKey = "night" | "lowGravity" | "meteorShower" | "fog";
const EVENT_KEYS: EventKey[] = ["night", "lowGravity", "meteorShower", "fog"];

/** Random scheduling parameters — events fire on independent timers so
 *  multiple events can stack (e.g. night + meteor shower) for some matches
 *  but never spam the player with overlapping toggles every tick. */
const EVENT_OFF_MIN_MS = 35_000;   // shortest gap between fires
const EVENT_OFF_MAX_MS = 95_000;   // longest gap between fires
const EVENT_ON_MIN_MS = 14_000;    // shortest active duration
const EVENT_ON_MAX_MS = 26_000;    // longest active duration
/** Initial delay so the first event doesn't fire the instant the match
 *  starts (gives players a chance to orient first). */
const EVENT_INITIAL_GRACE_MS = 25_000;

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

  /** Which event channels are *eligible* to fire in this match. The host
   *  picks these at room creation and they don't change after that. The
   *  *currently active* events live in `state.events` and are flipped by
   *  the server's random scheduler. */
  private enabledEvents = { night: false, lowGravity: false, meteorShower: false, fog: false };
  /** Random scheduler state per event: when the next activation is due,
   *  and when the currently active occurrence will end (0 = inactive). */
  private eventSched: Record<EventKey, { nextFireAt: number; deactivateAt: number }> = {
    night:        { nextFireAt: 0, deactivateAt: 0 },
    lowGravity:   { nextFireAt: 0, deactivateAt: 0 },
    meteorShower: { nextFireAt: 0, deactivateAt: 0 },
    fog:          { nextFireAt: 0, deactivateAt: 0 },
  };

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
      // Stagger the initial fire times so enabled events don't all trigger
      // at the same instant. Each gets a random offset on top of the grace.
      const now = Date.now();
      for (const k of EVENT_KEYS) {
        if (this.enabledEvents[k]) {
          this.eventSched[k].nextFireAt = now + EVENT_INITIAL_GRACE_MS + Math.random() * 30_000;
        }
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

    // Match-event scheduler. Each enabled event independently flips on
    // for a random duration, then off, then waits a random gap before its
    // next activation. Disabled events stay off forever.
    for (const key of EVENT_KEYS) {
      if (!this.enabledEvents[key]) continue;
      const t = this.eventSched[key];
      // Time to deactivate?
      if (t.deactivateAt > 0 && now >= t.deactivateAt) {
        this.state.events[key] = false;
        t.deactivateAt = 0;
        t.nextFireAt = now + EVENT_OFF_MIN_MS + Math.random() * (EVENT_OFF_MAX_MS - EVENT_OFF_MIN_MS);
      }
      // Time to fire?
      if (t.deactivateAt === 0 && t.nextFireAt > 0 && now >= t.nextFireAt) {
        this.state.events[key] = true;
        t.deactivateAt = now + EVENT_ON_MIN_MS + Math.random() * (EVENT_ON_MAX_MS - EVENT_ON_MIN_MS);
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
