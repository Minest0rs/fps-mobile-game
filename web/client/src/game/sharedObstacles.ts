/** Deterministic obstacle list shared between the client (which renders
 *  meshes + uses these for player collision) and the server (which uses
 *  them for bot line-of-sight checks).
 *
 *  We avoid any terrain-height dependency on purpose: the server doesn't
 *  know the heightfield, and LOS only needs XZ overlap. The client snaps
 *  the meshes to the terrain at render time. This means a few obstacles
 *  may appear half-buried on slopes, but the new visual designs (rocks,
 *  trees, shacks) look reasonable buried. Boxy crates that read poorly
 *  buried are placed in flat ring-radii to minimise that case.
 *
 *  IMPORTANT: this file must be byte-identical between client and server
 *  to keep their views of the world in sync. */

export type ObstacleType = "rock" | "tree" | "shack" | "crate";

export interface SharedObstacle {
  x: number;
  z: number;
  /** Total width along X. */
  w: number;
  /** Total depth along Z. */
  d: number;
  /** Visual height (used by the client; server uses for tall-cover hints). */
  h: number;
  type: ObstacleType;
  /** Cosmetic seed (e.g. tree foliage colour variant, rock rotation). */
  variant: number;
}

/** Deterministic heightfield sample. Must stay byte-identical to the
 *  client's `terrainHeight()` so the server's LOS / spawn snapping agrees
 *  with the visual terrain players walk on. */
export function terrainHeight(x: number, z: number, half: number): number {
  const r = Math.hypot(x, z);
  if (r > half - 60) {
    const t = Math.min(1, (r - (half - 60)) / 60);
    return 4 + t * t * 80;
  }
  const mx = -half * 0.45, mz = half * 0.45;
  const md = Math.hypot(x - mx, z - mz);
  const mountain = Math.exp(-(md * md) / (90 * 90)) * 55;
  const riverWidth = 32;
  const riverFactor = Math.exp(-(z * z) / (riverWidth * riverWidth));
  const river = -6 * riverFactor;
  // Hills are heavily damped inside the river ribbon so stray peaks
  // can't poke up through the water surface.
  const hillDamp = 1 - riverFactor * 0.85;
  const hills = (
    Math.sin(x * 0.035) * 1.4 +
    Math.cos(z * 0.045) * 1.1 +
    Math.sin((x + z) * 0.025) * 0.9 +
    Math.cos((x - z) * 0.030) * 0.7
  ) * hillDamp;
  const spawnInfluence = Math.exp(-(r * r) / (22 * 22));
  let h = (mountain + river + hills) * (1 - spawnInfluence);
  // Inside the river ribbon, clamp the bed below the water surface
  // (water sits at y = -0.4) so the water plane never gets pierced
  // by a stray hill peak (Devin Review BUG_0009).
  if (riverFactor > 0.25) {
    const cap = -1.2 - 4 * riverFactor; // -1.2 at edge → -5.2 at centre
    if (h > cap) h = cap;
  }
  return h;
}

/** Returns true if the terrain *between* (x1,z1) and (x2,z2) rises above
 *  the eye-line connecting eye heights y1 and y2 (i.e. a hill is in the
 *  way). Samples uniformly along the segment. */
export function segmentBlockedByTerrain(
  x1: number, z1: number, y1: number,
  x2: number, z2: number, y2: number,
  half: number,
): boolean {
  const samples = 12;
  // Skip the two endpoints so the bot doesn't accidentally call its own
  // muzzle position "blocked".
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const x = x1 + (x2 - x1) * t;
    const z = z1 + (z2 - z1) * t;
    const y = y1 + (y2 - y1) * t;
    if (terrainHeight(x, z, half) + 0.5 > y) return true;
  }
  return false;
}

/** Mulberry32 — small deterministic PRNG. Identical output for identical
 *  seed across both client and server. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate the canonical obstacle list for a given playable radius.
 *  Seeded so every client and the server get the same layout. */
export function generateObstacles(arenaHalf: number): SharedObstacle[] {
  const out: SharedObstacle[] = [];
  const playableR = arenaHalf - 70;
  const inRiver = (x: number, z: number) => Math.abs(z) < 18 && Math.abs(x) < playableR * 0.9;
  const tooClose = (x: number, z: number, minDist: number) => {
    for (const o of out) {
      const dx = o.x - x, dz = o.z - z;
      if (dx * dx + dz * dz < minDist * minDist) return true;
    }
    return false;
  };
  /** Maximum vertical difference (metres) anywhere within a ±r metre
   *  square around (x, z). Anything above ~0.6 m per metre footprint is
   *  too steep for an axis-aligned obstacle to sit cleanly without
   *  levitating on the downhill side. We sample interior points in
   *  addition to corners because some hills crest *inside* the box. */
  const slopeRange = (x: number, z: number, r: number) => {
    let lo = Infinity, hi = -Infinity;
    const samples = [
      [-r, -r], [r, -r], [-r, r], [r, r],
      [-r,  0], [r,  0], [ 0, -r], [0, r],
      [ 0,  0],
      [-r * 0.5, -r * 0.5], [r * 0.5, r * 0.5],
      [-r * 0.5,  r * 0.5], [r * 0.5, -r * 0.5],
    ];
    for (const [ox, oz] of samples) {
      const h = terrainHeight(x + ox, z + oz, arenaHalf);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    return hi - lo;
  };
  /** True if the obstacle at (x, z) with footprint half-size r should
   *  be skipped because the terrain underneath is too uneven. The limit
   *  scales with footprint — a small rock can tolerate more relative
   *  slope than a wide shack. */
  const tooSteep = (x: number, z: number, r: number, maxRise: number) =>
    slopeRange(x, z, r) > maxRise;

  // ---- Rocks (replaces the old crates / bunker walls) -----------------
  // A spread of medium-sized boulders across the arena. Rocks are short
  // enough that you can crouch behind them but tall enough to break LOS.
  const rockRng = mulberry32(7331);
  const rockCount = 140;
  for (let attempts = 0; out.filter(o => o.type === "rock").length < rockCount && attempts < rockCount * 4; attempts++) {
    const ang = rockRng() * Math.PI * 2;
    const dist = Math.sqrt(rockRng()) * playableR;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (x * x + z * z < 36) continue;        // not on the centre pillar
    if (inRiver(x, z)) continue;
    const r = 1.4 + rockRng() * 1.6;
    if (tooClose(x, z, r + 1.5)) continue;
    // Rocks tolerate moderate slope: their lower half is buried in the
    // ground anyway, so a 0.6 m rise across the footprint is fine.
    if (tooSteep(x, z, r, 0.6 + r * 0.4)) continue;
    const h = r * 1.4 + rockRng() * 0.4;
    out.push({ x, z, w: r * 2, d: r * 2, h, type: "rock", variant: Math.floor(rockRng() * 8) });
  }

  // ---- Trees ----------------------------------------------------------
  // Tall but thin cover. Players can hide behind a tree to break LOS but
  // trees are narrow so a step sideways exposes them.
  const treeRng = mulberry32(2048);
  const treeCount = 90;
  for (let attempts = 0; out.filter(o => o.type === "tree").length < treeCount && attempts < treeCount * 4; attempts++) {
    const ang = treeRng() * Math.PI * 2;
    const dist = Math.sqrt(treeRng()) * playableR;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (x * x + z * z < 64) continue;
    if (inRiver(x, z)) continue;
    if (tooClose(x, z, 3.5)) continue;
    // Trees can sit on light slopes (the trunk is buried 0.4 m), but skip
    // anything where the ground tilts more than 1 m across the tiny
    // 0.5 m footprint — those look obviously wrong.
    if (tooSteep(x, z, 0.6, 1.0)) continue;
    const h = 6 + treeRng() * 4;
    // Trunk is narrow but the canopy is wider — for LOS we use the trunk
    // (so you can see/shoot under the canopy), which is realistic.
    out.push({ x, z, w: 1.0, d: 1.0, h, type: "tree", variant: Math.floor(treeRng() * 6) });
  }

  // ---- Shacks (small wooden cabins) ----------------------------------
  // Larger pieces of cover. Sparse — about a dozen scattered around the
  // map at varied distances so the layout feels intentional.
  const shackRng = mulberry32(9001);
  const shackCount = 14;
  for (let attempts = 0; out.filter(o => o.type === "shack").length < shackCount && attempts < shackCount * 8; attempts++) {
    const ang = shackRng() * Math.PI * 2;
    const dist = (0.25 + shackRng() * 0.75) * playableR;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    if (x * x + z * z < 200) continue;
    if (inRiver(x, z)) continue;
    if (tooClose(x, z, 12)) continue;
    const w = 5 + shackRng() * 2;
    const d = 4 + shackRng() * 2;
    // Shacks are big and boxy — even a small slope makes their floor seam
    // visible from one side. Reject anywhere with more than 0.7 m of rise
    // across the larger footprint half-extent.
    if (tooSteep(x, z, Math.max(w, d) / 2, 0.7)) continue;
    out.push({ x, z, w, d, h: 3.5, type: "shack", variant: Math.floor(shackRng() * 4) });
  }

  // ---- Crates --------------------------------------------------------
  // A handful of small wooden crates, mostly clustered near shacks so they
  // look like loading-dock loot rather than random litter.
  const crateRng = mulberry32(4242);
  const shacks = out.filter(o => o.type === "shack");
  for (const sh of shacks) {
    const cluster = 2 + Math.floor(crateRng() * 3);
    for (let i = 0; i < cluster; i++) {
      const ox = (crateRng() - 0.5) * (sh.w + 5);
      const oz = (crateRng() - 0.5) * (sh.d + 5);
      const cx = sh.x + ox, cz = sh.z + oz;
      if (Math.abs(ox) < sh.w / 2 + 0.5 && Math.abs(oz) < sh.d / 2 + 0.5) continue; // not inside the shack
      if (tooClose(cx, cz, 1.6)) continue;
      const s = 1.2 + crateRng() * 0.6;
      // Crates are small but their corners catch the eye — skip steep ground.
      if (tooSteep(cx, cz, s / 2, 0.5)) continue;
      out.push({ x: cx, z: cz, w: s, d: s, h: s, type: "crate", variant: Math.floor(crateRng() * 4) });
    }
  }

  return out;
}

/** Test whether the line segment (x1, z1) → (x2, z2) intersects any of the
 *  given AABBs in the XZ plane. Used by bot AI to skip shots that don't
 *  have line of sight. */
export function segmentBlockedByObstacles(
  x1: number, z1: number,
  x2: number, z2: number,
  obstacles: SharedObstacle[],
): boolean {
  for (const o of obstacles) {
    // Skip very thin obstacles (trees) for LOS — bots can shoot past trunks.
    // Inflate everything else slightly so partial cover still blocks.
    const pad = o.type === "tree" ? -0.3 : 0.4;
    const minX = o.x - o.w / 2 - pad;
    const maxX = o.x + o.w / 2 + pad;
    const minZ = o.z - o.d / 2 - pad;
    const maxZ = o.z + o.d / 2 + pad;
    if (segmentIntersectsRect(x1, z1, x2, z2, minX, minZ, maxX, maxZ)) return true;
  }
  return false;
}

/** Liang-Barsky-ish test: does the 2D segment (x1,z1)→(x2,z2) overlap the
 *  axis-aligned rectangle [minX,minZ]–[maxX,maxZ]? Returns true on any
 *  intersection. */
function segmentIntersectsRect(
  x1: number, z1: number, x2: number, z2: number,
  minX: number, minZ: number, maxX: number, maxZ: number,
): boolean {
  // Quick reject — both endpoints on the same outside side.
  if (x1 < minX && x2 < minX) return false;
  if (x1 > maxX && x2 > maxX) return false;
  if (z1 < minZ && z2 < minZ) return false;
  if (z1 > maxZ && z2 > maxZ) return false;
  // Endpoint inside the rect counts as a hit.
  if (x1 >= minX && x1 <= maxX && z1 >= minZ && z1 <= maxZ) return true;
  if (x2 >= minX && x2 <= maxX && z2 >= minZ && z2 <= maxZ) return true;
  // Test against each rect edge.
  return (
    segmentsIntersect(x1, z1, x2, z2, minX, minZ, maxX, minZ) ||
    segmentsIntersect(x1, z1, x2, z2, maxX, minZ, maxX, maxZ) ||
    segmentsIntersect(x1, z1, x2, z2, maxX, maxZ, minX, maxZ) ||
    segmentsIntersect(x1, z1, x2, z2, minX, maxZ, minX, minZ)
  );
}

function segmentsIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1x = bx - ax, d1z = bz - az;
  const d2x = dx - cx, d2z = dz - cz;
  const denom = d1x * d2z - d1z * d2x;
  if (Math.abs(denom) < 1e-9) return false; // parallel
  const tx = cx - ax, tz = cz - az;
  const t = (tx * d2z - tz * d2x) / denom;
  const u = (tx * d1z - tz * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
