/**
 * Local-only player profile: name, level, XP, and unlocked skin selection.
 * Persists in localStorage so progression carries across sessions on the same device.
 */
const KEY = "fps-web-profile-v1";

export interface Profile {
  name: string;
  skin: string;
  level: number;
  xp: number;
  weapon?: string;
}

const DEFAULT: Profile = { name: "Player", skin: "neon", level: 1, xp: 0, weapon: "rifle" };

export const SKINS: Record<string, { color: number; emissive: number; unlock: number; label: string }> = {
  neon:    { color: 0x4cffd6, emissive: 0x114433, unlock: 0, label: "Neon" },
  crimson: { color: 0xff4c6e, emissive: 0x441120, unlock: 0, label: "Crimson" },
  cyber:   { color: 0x9d6bff, emissive: 0x301a55, unlock: 2, label: "Cyber" },
  gold:    { color: 0xffd66e, emissive: 0x554622, unlock: 5, label: "Gold" },
};

export const XP_PER_KILL = 100;

/** Quadratic-ish XP curve: cumulative XP needed to reach `level`. */
export function xpToReach(level: number): number {
  return Math.round(100 * Math.pow(Math.max(1, level), 1.5));
}

export function load(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}

export function save(p: Profile) {
  localStorage.setItem(KEY, JSON.stringify(p));
}

/** Add XP for a kill. Returns the number of levels gained. */
export function addKillXp(p: Profile): number {
  let levels = 0;
  p.xp += XP_PER_KILL;
  while (p.xp >= xpToReach(p.level + 1)) {
    p.level += 1;
    levels += 1;
  }
  save(p);
  return levels;
}

export function isSkinUnlocked(p: Profile, skinId: string): boolean {
  const s = SKINS[skinId];
  if (!s) return false;
  return p.level >= s.unlock;
}
