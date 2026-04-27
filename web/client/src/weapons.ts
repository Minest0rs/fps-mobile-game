/** Catalogue of weapons available to players. The same definitions live on
 *  the server (mirrored in `server/src/weapons.ts`) so damage and fire-rate
 *  rules are authoritative — clients only render and predict.  */
export interface WeaponDef {
  id: string;
  label: string;
  /** Damage per pellet/bullet. Multiply by `pellets` for total burst damage. */
  damage: number;
  /** Minimum interval between shots, ms. */
  fireRateMs: number;
  /** Rounds per magazine. */
  magSize: number;
  /** Reload time, ms. */
  reloadMs: number;
  /** Maximum ray length, world metres. Beyond this the bullet vanishes. */
  maxRange: number;
  /** Number of pellets fired per trigger pull (1 for everything except shotgun). */
  pellets: number;
  /** Cone half-angle for pellet spread, radians. 0 for hitscan rifles. */
  spread: number;
  /** Tracer colour, hex. */
  tracerColor: number;
  /** Tracer thickness, world metres. */
  tracerWidth: number;
  /** Subjective strength of the gun shake on each shot, radians. */
  recoil: number;
  /** Short blurb shown under the weapon picker. */
  blurb: string;
}

export const WEAPONS: Record<string, WeaponDef> = {
  rifle: {
    id: "rifle", label: "Assault Rifle",
    damage: 22, fireRateMs: 110, magSize: 30, reloadMs: 1600,
    maxRange: 200, pellets: 1, spread: 0,
    tracerColor: 0xfff09a, tracerWidth: 0.55, recoil: 0.012,
    blurb: "Balanced — solid at every range.",
  },
  smg: {
    id: "smg", label: "SMG",
    damage: 13, fireRateMs: 65, magSize: 36, reloadMs: 1400,
    maxRange: 90, pellets: 1, spread: 0.012,
    tracerColor: 0xa8e6ff, tracerWidth: 0.45, recoil: 0.008,
    blurb: "Fast fire-rate, weaker hits, falls off at long range.",
  },
  shotgun: {
    id: "shotgun", label: "Shotgun",
    damage: 11, fireRateMs: 650, magSize: 6, reloadMs: 2400,
    maxRange: 50, pellets: 8, spread: 0.10,
    tracerColor: 0xffae6a, tracerWidth: 0.50, recoil: 0.030,
    blurb: "Devastating up close, near-useless past 30 m.",
  },
  sniper: {
    id: "sniper", label: "Sniper",
    damage: 95, fireRateMs: 1100, magSize: 5, reloadMs: 2800,
    maxRange: 320, pellets: 1, spread: 0,
    tracerColor: 0xff7d7d, tracerWidth: 0.70, recoil: 0.045,
    blurb: "One-shot to the body at any range, slow fire.",
  },
  pistol: {
    id: "pistol", label: "Pistol",
    damage: 18, fireRateMs: 230, magSize: 12, reloadMs: 1100,
    maxRange: 80, pellets: 1, spread: 0.004,
    tracerColor: 0xfde08a, tracerWidth: 0.45, recoil: 0.014,
    blurb: "Reliable side-arm. Decent up close, smaller mag.",
  },
};

export function getWeapon(id: string | undefined): WeaponDef {
  return (id && WEAPONS[id]) || WEAPONS.rifle;
}
