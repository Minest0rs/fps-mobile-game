import { ArenaState, Player } from "./state.js";
import { WEAPONS, getWeapon } from "./weapons.js";

/** Difficulty profile applied to bots at spawn time. */
const DIFFICULTY = {
  easy:   { aimError: 0.30, fireDelayMs: 900, hp: 80,  speed: 4.0 },
  normal: { aimError: 0.18, fireDelayMs: 600, hp: 100, speed: 4.8 },
  hard:   { aimError: 0.08, fireDelayMs: 350, hp: 120, speed: 5.6 },
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
    bot.botSkill = profile.aimError;
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
    // Always face the target.
    bot.yaw = Math.atan2(dx, dz);

    // Fire if the target is within weapon range and our cooldown is up.
    const w = getWeapon(bot.weapon);
    const cooldown = Math.max(w.fireRateMs, profile.fireDelayMs);
    if (dist < w.maxRange && now - bot.lastShotAt > cooldown) {
      // Random miss chance based on aimError — bots aren't perfect.
      if (Math.random() > profile.aimError) {
        events.push({ attackerId: bot.id, victimId: target.id, damage: w.damage });
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
