import { ArenaState, Player } from "./state.js";
import { WEAPONS, getWeapon } from "./weapons.js";
import { generateObstacles, segmentBlockedByObstacles, type SharedObstacle } from "./sharedObstacles.js";

/** Shared obstacle list used by bot LOS checks. Generated once per process
 *  (the layout is deterministic and arena-half-dependent only). */
let cachedObstacles: SharedObstacle[] | null = null;
function getObstacles(arenaHalf: number): SharedObstacle[] {
  if (!cachedObstacles) cachedObstacles = generateObstacles(arenaHalf);
  return cachedObstacles;
}

/** Difficulty profile applied to bots at spawn time.
 *  - `hitChance` is the per-shot probability of actually applying damage
 *    (0 = always misses, 1 = always hits). Tuned so even Hard bots are
 *    ambient pressure rather than instant-death turrets.
 *  - `fireDelayMs` is added on top of the weapon's natural fire-rate as a
 *    "reaction time" gap between bot shots.
 *  - `hp` and `speed` shape how much of a fight each bot puts up. */
const DIFFICULTY = {
  easy:   { hitChance: 0.10, fireDelayMs: 1800, hp: 50, speed: 3.2 },
  normal: { hitChance: 0.20, fireDelayMs: 1300, hp: 70, speed: 4.0 },
  hard:   { hitChance: 0.35, fireDelayMs:  900, hp: 90, speed: 4.8 },
} as const;

export type BotDifficulty = keyof typeof DIFFICULTY;

const BOT_NAMES = [
  "Specter", "Phantom", "Wraith", "Reaper", "Nova", "Echo",
  "Vortex", "Cinder", "Talon", "Rogue", "Hex", "Volt",
];

/** Spawn `count` server-controlled bots into the room state. They share the
 *  same Player schema so clients render them like any other player. */
export function spawnBots(
  state: ArenaState,
  count: number,
  difficulty: BotDifficulty,
  spawnPoint: () => { x: number; y: number; z: number },
) {
  const profile = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  const usedNames = new Set<string>();
  for (let i = 0; i < count; i++) {
    const bot = new Player();
    bot.id = `bot:${i}:${Math.random().toString(36).slice(2, 7)}`;
    bot.isBot = true;
    bot.skin = ["neon", "crimson", "cyber", "gold"][i % 4];
    // Pick an unused name where possible.
    let nm = BOT_NAMES[i % BOT_NAMES.length];
    let suffix = 1;
    while (usedNames.has(nm)) nm = `${BOT_NAMES[i % BOT_NAMES.length]} ${++suffix}`;
    usedNames.add(nm);
    bot.name = nm;
    // Bots cycle through the available weapons so matches feel varied.
    const wIds = Object.keys(WEAPONS);
    bot.weapon = wIds[i % wIds.length];
    bot.hp = profile.hp;
    bot.botSkill = profile.hitChance;
    const sp = spawnPoint();
    bot.x = sp.x; bot.y = sp.y; bot.z = sp.z;
    bot.botTargetX = sp.x;
    bot.botTargetZ = sp.z;
    state.players.set(bot.id, bot);
  }
}

/** Per-tick bot AI: walk toward the nearest human-controlled player, stop
 *  when within preferred range, fire when the human is in front and within
 *  weapon range. This is intentionally simple — bots are atmosphere, not
 *  serious adversaries.
 *
 *  Returns a list of `{ attackerId, victimId, damage }` entries describing
 *  shots resolved this tick so the room can apply damage and emit kills. */
export function tickBots(
  state: ArenaState,
  difficulty: BotDifficulty,
  dt: number,
  arenaHalf: number,
  spawnPoint: () => { x: number; y: number; z: number },
): Array<{ attackerId: string; victimId: string; damage: number }> {
  const profile = DIFFICULTY[difficulty] ?? DIFFICULTY.normal;
  const now = Date.now();
  const events: Array<{ attackerId: string; victimId: string; damage: number }> = [];

  // Snapshot the current human players so bots prefer hunting them rather
  // than each other (otherwise pure bot lobbies would be a snake-pit).
  const humans: Player[] = [];
  state.players.forEach((p) => { if (!p.isBot && p.hp > 0) humans.push(p); });

  state.players.forEach((bot) => {
    if (!bot.isBot) return;

    // Respawn dead bots after the same delay as humans.
    if (bot.hp <= 0) {
      if (bot.respawnAt > 0 && now >= bot.respawnAt) {
        const sp = spawnPoint();
        bot.x = sp.x; bot.y = sp.y; bot.z = sp.z;
        bot.hp = profile.hp;
        bot.respawnAt = 0;
      }
      return;
    }

    // Pick the nearest human (or any other live bot if no humans).
    let nearest: Player | null = null;
    let nearestDistSq = Infinity;
    const candidates = humans.length > 0 ? humans : [];
    if (candidates.length === 0) {
      state.players.forEach((p) => {
        if (p === bot || p.hp <= 0) return;
        const d = sqDistXZ(bot, p);
        if (d < nearestDistSq) { nearestDistSq = d; nearest = p; }
      });
    } else {
      for (const h of candidates) {
        const d = sqDistXZ(bot, h);
        if (d < nearestDistSq) { nearestDistSq = d; nearest = h; }
      }
    }

    if (!nearest) return;
    const target = nearest as Player;

    // Walk toward the target, but stop at a comfortable engagement range
    // (~20 m) so bots don't faceplant on the player.
    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const desired = 18;
    if (dist > desired) {
      const step = profile.speed * dt;
      bot.x += (dx / dist) * step;
      bot.z += (dz / dist) * step;
      bot.x = clamp(bot.x, -arenaHalf, arenaHalf);
      bot.z = clamp(bot.z, -arenaHalf, arenaHalf);
    }
    // Always face the target. The avatar's forward in this codebase is
    // `(-sin(yaw), 0, -cos(yaw))` (matches `controller.ts` and the gun's
    // local -Z), so to face direction `(dx, dz)` we need `atan2(-dx, -dz)`.
    // Using `atan2(dx, dz)` would point the avatar 180° away from the
    // target (Devin Review BUG_0003).
    bot.yaw = Math.atan2(-dx, -dz);

    // Fire if the target is within weapon range and our cooldown is up.
    const w = getWeapon(bot.weapon);
    const cooldown = Math.max(w.fireRateMs, profile.fireDelayMs);
    // Cap bot effective range — even a sniper bot only fires within 60 m
    // so the open 600 m arena doesn't turn into a turret simulator.
    const botRange = Math.min(w.maxRange, 60);
    if (dist < botRange && now - bot.lastShotAt > cooldown) {
      // LOS: if any obstacle (rock / shack / crate) blocks the segment
      // between bot and target, the shot is suppressed. This is what
      // lets players actually use cover.
      const obstacles = getObstacles(arenaHalf);
      if (segmentBlockedByObstacles(bot.x, bot.z, target.x, target.z, obstacles)) {
        bot.lastShotAt = now;
        return;
      }
      // Most bot shots miss. We also bleed off accuracy with distance so
      // bots feel weaker the further you are from them — important for
      // making the open 600 m arena playable against AI.
      const distFalloff = Math.max(0, 1 - dist / botRange);
      const effectiveChance = profile.hitChance * (0.4 + 0.6 * distFalloff);
      if (Math.random() < effectiveChance) {
        // Bot damage is also reduced — weapon damage is calibrated for
        // human aim (single targeted shot per click), and a bot shooting
        // at human cadence at full damage feels overwhelming.
        const dmg = Math.max(4, Math.round(w.damage * 0.5));
        events.push({ attackerId: bot.id, victimId: target.id, damage: dmg });
      }
      bot.lastShotAt = now;
    }
  });

  return events;
}

function sqDistXZ(a: Player, b: Player) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
