/** Authoritative weapon catalogue for damage and fire-rate enforcement.
 *  Mirrored from `client/src/weapons.ts` — keep in sync. */
export interface WeaponDef {
  id: string;
  damage: number;
  fireRateMs: number;
  /** Total damage cap per trigger pull (used to clamp shotgun pellets). */
  pellets: number;
  maxRange: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  rifle:   { id: "rifle",   damage: 22, fireRateMs: 110, pellets: 1, maxRange: 200 },
  smg:     { id: "smg",     damage: 13, fireRateMs: 65,  pellets: 1, maxRange: 90 },
  shotgun: { id: "shotgun", damage: 11, fireRateMs: 650, pellets: 8, maxRange: 50 },
  sniper:  { id: "sniper",  damage: 95, fireRateMs: 1100, pellets: 1, maxRange: 320 },
  pistol:  { id: "pistol",  damage: 18, fireRateMs: 230, pellets: 1, maxRange: 80 },
};

export function getWeapon(id: string | undefined): WeaponDef {
  return (id && WEAPONS[id]) || WEAPONS.rifle;
}
