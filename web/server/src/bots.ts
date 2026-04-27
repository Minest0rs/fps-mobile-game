import { ArenaState, Player } from "./state.js";
import { WEAPONS, getWeapon } from "./weapons.js";
import {
  generateObstacles,
  segmentBlockedByObstacles,
  segmentBlockedByTerrain,
  terrainHeight,
  type SharedObstacle,
} from "./sharedObstacles.js";

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
    let nm = BOT_NAMES[i % BOT_NAMES.length];
    let suffix = 1;
    while (usedNames.has(nm)) nm = `${BOT_NAMES[i % BOT_NAMES.length]} ${++suffix}`;
    usedNames.add(nm);
    bot.name = nm;
    const wIds = Object.keys(WEAPONS);
    bot.weapon = wIds[i % wIds.length];
    bot.hp = profile.hp;
    bot.botSkill = profile.hitChance;
    // Spread bots across the map at spawn instead of clustering in the
    // central spawn ring — without this they all aggro on each other in
    // a 60 m radius and stand still at their preferred engagement range.
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const r = 80 + Math.random() * 220;
    bot.x = Math.cos(angle) * r;
    bot.z = Math.sin(angle) * r;
    bot.y = 5; // tickBots will snap to terrain on first frame
    bot.botTargetX = bot.x;
    bot.botTargetZ = bot.z;
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

  state.players.forEach((bot) => {
    if (!bot.isBot) return;

    // Snap bot Y to the heightfield each tick so they walk on terrain
    // instead of hovering at the spawn Y. Without this, a bot that walks
    // up the mountain ends up "swimming" through it.
    bot.y = terrainHeight(bot.x, bot.z, arenaHalf) + 1.6;

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

    // Pick the nearest live entity (human OR other bot). Humans are
    // weighted as if they were ~30% closer so a bot prefers the player
    // when both are in range, but still aggros on its peers when no
    // human is nearby. This keeps bot lobbies alive while you hide.
    let nearest: Player | null = null;
    let nearestScore = Infinity;
    state.players.forEach((p) => {
      if (p === bot || p.hp <= 0) return;
      const d2 = sqDistXZ(bot, p);
      const score = p.isBot ? d2 : d2 * 0.5;
      if (score < nearestScore) { nearestScore = score; nearest = p; }
    });

    const obstacles = getObstacles(arenaHalf);
    const w = getWeapon(bot.weapon);
    const cooldown = Math.max(w.fireRateMs, profile.fireDelayMs);
    const botRange = Math.min(w.maxRange, 60);
    const lowHp = bot.hp < profile.hp * 0.35;

    // No live targets in range → wander toward a random patrol point so
    // bots aren't standing perfectly still. Re-pick when close.
    if (!nearest) {
      const dxw = bot.botTargetX - bot.x;
      const dzw = bot.botTargetZ - bot.z;
      const dw = Math.sqrt(dxw * dxw + dzw * dzw);
      if (dw < 6) {
        bot.botTargetX = (Math.random() - 0.5) * arenaHalf * 1.4;
        bot.botTargetZ = (Math.random() - 0.5) * arenaHalf * 1.4;
      } else {
        const step = profile.speed * 0.6 * dt;
        bot.x = clamp(bot.x + (dxw / dw) * step, -arenaHalf, arenaHalf);
        bot.z = clamp(bot.z + (dzw / dw) * step, -arenaHalf, arenaHalf);
        bot.yaw = Math.atan2(-dxw, -dzw);
      }
      return;
    }
    const target = nearest as Player;

    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    // Always face the target. forward is `(-sin(yaw), 0, -cos(yaw))` so
    // to face direction `(dx, dz)` we need `atan2(-dx, -dz)`.
    bot.yaw = Math.atan2(-dx, -dz);

    // Pre-compute LOS so we can both gate firing AND drive movement.
    const losTerrain = segmentBlockedByTerrain(bot.x, bot.z, bot.y, target.x, target.z, target.y, arenaHalf);
    const losObstacle = !losTerrain && segmentBlockedByObstacles(bot.x, bot.z, target.x, target.z, obstacles);
    const hasLOS = !losTerrain && !losObstacle;

    // Movement: low HP retreats, no LOS pushes forward to flank, with
    // LOS within range strafes sideways at a comfortable distance.
    const desired = 18;
    const moveStep = profile.speed * dt;
    let mx = 0, mz = 0;
    if (lowHp && hasLOS) {
      // Backpedal away from the target.
      mx = -(dx / dist) * moveStep;
      mz = -(dz / dist) * moveStep;
    } else if (!hasLOS || dist > desired + 4) {
      // Push toward the target so we can break cover / close distance.
      mx = (dx / dist) * moveStep;
      mz = (dz / dist) * moveStep;
    } else if (dist < desired - 6) {
      // Too close, back off slightly.
      mx = -(dx / dist) * moveStep * 0.6;
      mz = -(dz / dist) * moveStep * 0.6;
    } else if (hasLOS) {
      // Strafe sideways while engaging — perpendicular to the target dir.
      const sign = (Math.floor(now / 1700) % 2 === 0) ? 1 : -1;
      mx = (-dz / dist) * moveStep * 0.7 * sign;
      mz = ( dx / dist) * moveStep * 0.7 * sign;
    }
    bot.x = clamp(bot.x + mx, -arenaHalf, arenaHalf);
    bot.z = clamp(bot.z + mz, -arenaHalf, arenaHalf);

    // Fire only when LOS is clean and within range.
    if (hasLOS && dist < botRange && now - bot.lastShotAt > cooldown) {
      const distFalloff = Math.max(0, 1 - dist / botRange);
      const effectiveChance = profile.hitChance * (0.4 + 0.6 * distFalloff);
      if (Math.random() < effectiveChance) {
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
