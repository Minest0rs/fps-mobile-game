import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";

export interface CylinderObstacle { x: number; z: number; r: number; }
export interface Obstacles {
  boxes: THREE.Box3[];
  cylinders: CylinderObstacle[];
}

export interface SceneRefs {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  arenaHalf: number;
  obstacles: Obstacles;
  /** Ground elevation at world (x, z); used by the controller for landing. */
  heightAt: (x: number, z: number) => number;
  /** The non-zoomed FOV the camera was last fit to (responsive to viewport). */
  getBaseFov: () => number;
  /** Re-position the sun so its shadow camera tracks the active player. */
  followSun: (playerX: number, playerZ: number) => void;
  /** World meshes the aim raycaster should consider (terrain + obstacles).
   *  Used to find the actual point the camera crosshair is pointing at so
   *  bullet trajectories can converge there at any range, not just 30 m. */
  aimMeshes: THREE.Object3D[];
}

/** Smoothly varying ground height. Kept identical between the visual ground
 *  geometry and the controller so the player never falls through the floor.
 *
 *  Layout for the open-world map:
 *    - Flat-ish spawn meadow near the centre.
 *    - A river depression carved along z = 0 (a shallow trough about 30 m wide).
 *    - A mountain peak in the (-x, +z) quadrant, rising to ~55 m.
 *    - Rolling hills everywhere else.
 *    - A massive cliff ring near the boundary (no straight walls); it climbs
 *      to ~80 m so players can't walk out of the playable area. */
export function terrainHeight(x: number, z: number, half: number): number {
  // Distance from centre and from the boundary (radial, not axis-aligned).
  const r = Math.hypot(x, z);

  // 1. Cliff ring — natural barrier replacing the old straight walls.
  //    Activates only in the outer 60 m. The ramp is quadratic so it's
  //    gentle at first then becomes a near-vertical wall.
  if (r > half - 60) {
    const t = Math.min(1, (r - (half - 60)) / 60);
    const cliff = 4 + t * t * 80;
    return cliff;
  }

  // 2. Mountain peak.
  const mx = -half * 0.45, mz = half * 0.45;
  const md = Math.hypot(x - mx, z - mz);
  // Wide gaussian for a smooth, walkable mountain.
  const mountain = Math.exp(-(md * md) / (90 * 90)) * 55;

  // 3. River — a deep, wide blue trough along z = 0. The bed sits 6 m below
  //    surrounding ground; tapers to flat ground over ±30 m on either side.
  //    Made deep + wide enough that the water mesh is clearly visible from
  //    any approach angle.
  const riverWidth = 26;
  const riverFactor = Math.exp(-(z * z) / (riverWidth * riverWidth));
  const river = -6 * riverFactor;

  // 4. Rolling hills (always-on background).
  const hills =
    Math.sin(x * 0.035) * 1.4 +
    Math.cos(z * 0.045) * 1.1 +
    Math.sin((x + z) * 0.025) * 0.9 +
    Math.cos((x - z) * 0.030) * 0.7;

  // 5. Spawn flat — keep a 25 m radius near the centre nearly level so
  //    starting the match isn't on a slope. Blend smoothly out.
  const spawnInfluence = Math.exp(-(r * r) / (22 * 22));
  const baseTerrain = mountain + river + hills;
  return baseTerrain * (1 - spawnInfluence);
}

/** Build the renderer, camera, lights, sky, ground, walls, and crates. */
export function createScene(host: HTMLElement): SceneRefs {
  const scene = new THREE.Scene();
  // Warm, hazy daytime air. The fog colour matches the sky's horizon band so
  // distant geometry blends into the skybox instead of cutting off sharply.
  scene.fog = new THREE.Fog(0xc4d4e6, 200, 700);
  const sunDir = buildSky(scene);

  // Vertical FOV is recomputed each resize to keep the horizontal FOV roughly
  // constant — Three.js exposes vertical FOV but FPS players think in
  // horizontal terms, and a fixed vfov feels cramped in portrait/mobile.
  const camera = new THREE.PerspectiveCamera(80, 1, 0.05, 600);
  // Sit the camera somewhere visible until the server tells us where to spawn.
  // (0,1.6,0) puts us inside the center pillar and shows nothing — avoid that.
  camera.position.set(8, 1.6, 8);
  camera.lookAt(0, 1.6, 0);

  // Try webgl2 with antialias; fall back to webgl1 without for older mobile GPUs.
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "default" });
  } catch (e) {
    console.warn("antialias renderer failed, retrying without:", e);
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "default" });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  host.appendChild(renderer.domElement);

  // Bright sky / dim ground hemisphere — fills shadows so nothing is pitch black.
  const ambient = new THREE.HemisphereLight(0xbcd6ff, 0x222a3a, 1.1);
  scene.add(ambient);

  // "Sun" — main shadow caster with warm tint, aligned with the Sky shader's
  // sun position so shadows feel consistent with the sky.
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.5);
  sun.position.copy(sunDir).multiplyScalar(40);
  sun.castShadow = true;
  // Shadows around the player; the directional sun follows player position
  // so the shadow camera stays focused on the active area.
  sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
  sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 250;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  scene.add(sun.target);

  // Cool "back light" from the opposite side to keep faces away from the sun
  // from going dark.
  const fill = new THREE.DirectionalLight(0x6fa8ff, 0.45);
  fill.position.set(-20, 18, -12);
  scene.add(fill);

  // Four colored accent point lights, one per quadrant — adds neon-arena vibe
  // and prevents pitch-black corners during night-mode skins.
  const accents: Array<[number, number, number, number]> = [
    [0xff4c6e,  28, 8,  28],
    [0x4cffd6, -28, 8,  28],
    [0x9d6bff,  28, 8, -28],
    [0xffd66e, -28, 8, -28],
  ];
  for (const [color, x, y, z] of accents) {
    const pl = new THREE.PointLight(color, 1.2, 50, 1.6);
    pl.position.set(x, y, z);
    scene.add(pl);
  }

  const arenaHalf = 300;
  const aimMeshes: THREE.Object3D[] = [];
  const obstacles = buildArena(scene, arenaHalf, aimMeshes);
  const heightAt = (x: number, z: number) => terrainHeight(x, z, arenaHalf);

  const TARGET_HFOV_DEG = 100; // wide enough to feel like a real FPS
  let baseFov = 80;
  const fit = () => {
    renderer.setSize(host.clientWidth, host.clientHeight);
    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    camera.aspect = aspect;
    // Convert target horizontal FOV → vertical FOV given the current aspect.
    const hfov = THREE.MathUtils.degToRad(TARGET_HFOV_DEG);
    let vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect);
    // Clamp so portrait phones don't get a fish-eye lens.
    vfov = Math.min(vfov, THREE.MathUtils.degToRad(95));
    vfov = Math.max(vfov, THREE.MathUtils.degToRad(60));
    baseFov = THREE.MathUtils.radToDeg(vfov);
    camera.fov = baseFov;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", fit);
  // ResizeObserver catches container changes that aren't window resizes
  // (e.g. browser chrome appearing on mobile, fullscreen toggles).
  new ResizeObserver(fit).observe(host);
  fit();

  const followSun = (px: number, pz: number) => {
    sun.target.position.set(px, 0, pz);
    sun.position.copy(sunDir).multiplyScalar(80).add(sun.target.position);
  };

  return { scene, camera, renderer, arenaHalf, obstacles, heightAt, getBaseFov: () => baseFov, followSun, aimMeshes };
}

function buildArena(scene: THREE.Scene, half: number, aimMeshes: THREE.Object3D[]): Obstacles {
  const obstacles: Obstacles = { boxes: [], cylinders: [] };
  // Helper that mirrors scene.add for solid meshes the aim raycaster should
  // consider. Skipped for water, grass tufts, and decorative far hills.
  const addSolid = (mesh: THREE.Object3D) => { scene.add(mesh); aimMeshes.push(mesh); };

  // Ground — vertex-coloured grass with real height variation. The same
  // terrainHeight() function is queried by the controller, so the player
  // can never fall through visible terrain.
  // SEG sets sampling density; we want ~5 m per quad on the inner ground.
  const SEG = Math.min(240, Math.max(96, Math.round(half / 2.5)));
  const groundGeom = new THREE.PlaneGeometry(half * 2, half * 2, SEG, SEG);
  const colours = new Float32Array(groundGeom.attributes.position.count * 3);
  const pos = groundGeom.attributes.position;
  const cRng = mulberry32(2024);
  for (let i = 0; i < pos.count; i++) {
    // Plane is rotated -PI/2 around X; that maps local +Y to world -Z, so we
    // must negate Y when sampling terrainHeight() (which uses world space)
    // — otherwise the visible ground is mirrored relative to where every
    // crate / collision check thinks it is.
    const wx = pos.getX(i), wy = pos.getY(i);
    const h = terrainHeight(wx, -wy, half);
    pos.setZ(i, h);
    // Tint by elevation: river bed sandy/blue, lowlands green, mid hills
    // a richer green, mountain peaks rocky grey-brown.
    const t = cRng();
    let r: number, g: number, b: number;
    if (h < -2.0) {
      // River bed — muddy blue-brown. Underwater so it reads as river floor.
      r = 0.30 + t * 0.06; g = 0.32 + t * 0.06; b = 0.32 + t * 0.06;
    } else if (h < -0.4) {
      // River bank — wet sand tone.
      r = 0.55 + t * 0.10; g = 0.50 + t * 0.08; b = 0.40 + t * 0.08;
    } else if (h > 25) {
      // Mountain rock — climbs from grey-green to white as you go up.
      const rockT = THREE.MathUtils.clamp((h - 25) / 30, 0, 1);
      r = 0.42 + rockT * 0.40 + t * 0.06;
      g = 0.42 + rockT * 0.38 + t * 0.06;
      b = 0.40 + rockT * 0.40 + t * 0.06;
    } else {
      // Default grass — mix of greens with a touch of dirt at higher ground.
      const dirt = THREE.MathUtils.clamp(h * 0.05, 0, 0.30);
      r = 0.28 + t * 0.18 + dirt * 0.5;
      g = 0.48 + t * 0.16;
      b = 0.20 + t * 0.10 + dirt * 0.15;
    }
    colours[i * 3 + 0] = r;
    colours[i * 3 + 1] = g;
    colours[i * 3 + 2] = b;
  }
  groundGeom.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  pos.needsUpdate = true;
  groundGeom.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeom, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  addSolid(ground);

  // Outer "landscape" — a much larger ground plane beyond the cliff ring so
  // the horizon doesn't end at the arena bounds. Constant low height (just
  // beyond the cliff) so it doesn't fight with the inner ground at the seam.
  const outerSeg = 96;
  const outerGeom = new THREE.PlaneGeometry(half * 6, half * 6, outerSeg, outerSeg);
  const outer = new THREE.Mesh(
    outerGeom,
    new THREE.MeshStandardMaterial({ color: 0x3d5a2c, roughness: 0.98 }),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.5;
  outer.receiveShadow = true;
  addSolid(outer);

  // River water — wide blue translucent ribbon along z = 0 sitting just
  // below the surrounding ground. Surface at y = -1.0 so the river reads as
  // ~5 m deep and the water plane is visible from any approach angle.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 1.7, 70),
    new THREE.MeshStandardMaterial({
      color: 0x1f5d8f, roughness: 0.18, metalness: 0.2,
      transparent: true, opacity: 0.82,
      side: THREE.DoubleSide,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -1.0, 0);
  water.renderOrder = 1; // draw on top of opaque terrain
  scene.add(water);

  // Distant decorative hills — green forested mounds beyond the play area.
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x2f4a23, roughness: 1.0 });
  const hillRng = mulberry32(909);
  for (let i = 0; i < 70; i++) {
    const angle = (i / 70) * Math.PI * 2 + hillRng() * 0.4;
    const dist = half * 1.6 + hillRng() * half * 1.8;
    const h = 6 + hillRng() * 16;
    const r = 6 + hillRng() * 12;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), hillMat);
    cone.position.set(Math.cos(angle) * dist, h / 2 - 0.5, Math.sin(angle) * dist);
    cone.rotation.y = hillRng() * Math.PI;
    scene.add(cone);
  }

  // Grass tufts — flat triangles scattered across the field. Cheap visual
  // noise that breaks up the otherwise uniform ground.
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0x4f7a31, roughness: 1.0, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
  });
  const grassGeom = new THREE.PlaneGeometry(0.4, 0.7);
  const grassCount = 400;
  const grass = new THREE.InstancedMesh(grassGeom, grassMat, grassCount);
  const dummy = new THREE.Object3D();
  const gRng = mulberry32(444);
  for (let i = 0; i < grassCount; i++) {
    const x = (gRng() * 2 - 1) * (half - 1);
    const z = (gRng() * 2 - 1) * (half - 1);
    if (x * x + z * z < 9) { i--; continue; } // not on the centre pillar
    const gy = terrainHeight(x, z, half);
    // Skip the river bed and high mountain rock — grass doesn't grow there.
    if (gy < -0.5) { i--; continue; }
    if (gy > 35) { i--; continue; }
    dummy.position.set(x, gy + 0.35, z);
    dummy.rotation.set(0, gRng() * Math.PI, 0);
    dummy.scale.set(0.7 + gRng() * 0.7, 0.6 + gRng() * 0.8, 1);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
  }
  scene.add(grass);

  // No straight boundary walls — the cliff ring in terrainHeight() forms a
  // natural barrier. mkBox is still useful for cover.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a577a, roughness: 0.6, metalness: 0.25 });
  const mkBox = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = wallMat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    addSolid(m);
    obstacles.boxes.push(new THREE.Box3(
      new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
    ));
  };

  // Crate / cover density scales with map area so the player still feels
  // like there's something to take cover behind even on a 600 m wide map.
  const playableR = half - 70; // stay clear of the cliff ramp
  const obsRng = mulberry32(1337);

  // Helper: max height delta within ±r metres of (x, z). Axis-aligned boxes
  // levitate visibly on steep slopes (corners poke into the air), so we
  // refuse to place obstacles where the slope would expose more than ~0.6 m.
  const slopeAt = (x: number, z: number, r: number) => {
    const a = terrainHeight(x + r, z, half);
    const b = terrainHeight(x - r, z, half);
    const c = terrainHeight(x, z + r, half);
    const d = terrainHeight(x, z - r, half);
    return Math.max(a, b, c, d) - Math.min(a, b, c, d);
  };

  // Cover bunkers — L-shaped walls. Cluster them into "battle zones" rather
  // than evenly distributing, so big swathes of map feel like wilderness.
  const bunkerMat = new THREE.MeshStandardMaterial({ color: 0x3d4a6c, roughness: 0.85 });
  const bunkerHubs: Array<[number, number]> = [
    [   0,  -90], [   0,   90],         // north / south of the river
    [ 110,    0], [-110,    0],         // east / west arms
    [  80,   80], [ -80,  -80],
    [ -80,   80], [  80,  -80],
    [ 160,   40], [-160,  -40],
    [  40,  160], [ -40, -160],
    [ 200,  200], [-200, -200],
    [ 200, -200], [-200,  200],
  ];
  for (const [hx, hz] of bunkerHubs) {
    if (Math.hypot(hx, hz) > playableR) continue;
    // Two L-shaped wall pairs per hub so each forms a small fortified spot.
    for (let k = 0; k < 2; k++) {
      const ox = (obsRng() - 0.5) * 14;
      const oz = (obsRng() - 0.5) * 14;
      const bx = hx + ox, bz = hz + oz;
      // Skip steep slopes where the wall would obviously levitate.
      if (slopeAt(bx, bz, 4) > 1.2) continue;
      const gy = terrainHeight(bx, bz, half);
      // Sink the base 0.3 m so any small mesh-vs-analytic mismatch hides
      // under the ground rather than appearing as a gap.
      mkBox(8, 2.4, 0.7, bx,     gy + 0.9, bz, bunkerMat);
      mkBox(0.7, 2.4, 6, bx + 4, gy + 0.9, bz - 3, bunkerMat);
    }
  }

  // Crates — deterministic positions so all clients see the same layout.
  // Density-based count: roughly 1 crate per 800 m² of playable area.
  const rng = mulberry32(7331);
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xb2823c, roughness: 0.78 });
  const crateCount = Math.min(220, Math.round((Math.PI * playableR * playableR) / 800));
  for (let i = 0; i < crateCount; i++) {
    const s = 1.2 + rng() * 1.4;
    // Sample within a disk so crates respect the round playable area.
    const ang = rng() * Math.PI * 2;
    const dist = Math.sqrt(rng()) * playableR;
    const px = Math.cos(ang) * dist;
    const pz = Math.sin(ang) * dist;
    if (px * px + pz * pz < 16) { i--; continue; }    // not on centre pillar
    if (Math.abs(pz) < 18 && Math.abs(px) < playableR * 0.9) { i--; continue; } // not in river
    if (slopeAt(px, pz, s * 0.6) > s * 0.8) { i--; continue; } // skip steep slopes
    const gy = terrainHeight(px, pz, half);
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
    // Sink half the slope-tolerance so corners on uneven ground stay buried.
    c.position.set(px, gy + s * 0.5 - 0.15, pz);
    c.castShadow = true; c.receiveShadow = true;
    addSolid(c);
    obstacles.boxes.push(new THREE.Box3(
      new THREE.Vector3(px - s / 2, gy,     pz - s / 2),
      new THREE.Vector3(px + s / 2, gy + s, pz + s / 2),
    ));
  }

  // Mid-sized "towers" — chest-high blocks that double as ramps onto crates.
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x52628a, roughness: 0.5, metalness: 0.3 });
  const towerRng = mulberry32(2048);
  const towerCount = 24;
  for (let i = 0; i < towerCount; i++) {
    const ang = towerRng() * Math.PI * 2;
    const dist = (0.2 + towerRng() * 0.7) * playableR;
    const tx = Math.cos(ang) * dist;
    const tz = Math.sin(ang) * dist;
    if (Math.abs(tz) < 18) continue; // not in river
    if (slopeAt(tx, tz, 1.5) > 1.0) continue; // skip steep slopes
    const gy = terrainHeight(tx, tz, half);
    mkBox(3, 1.4, 3, tx, gy + 0.55, tz, towerMat);
  }

  // Center pillar with a glowing top so the middle of the arena is a landmark.
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 5, 24),
    new THREE.MeshStandardMaterial({ color: 0x6478a8, roughness: 0.4, metalness: 0.5 }),
  );
  pillar.position.set(0, 2.5, 0);
  pillar.castShadow = true; pillar.receiveShadow = true;
  addSolid(pillar);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x4cffd6, emissiveIntensity: 2.8,
      roughness: 0.2, metalness: 0.0,
    }),
  );
  beacon.position.set(0, 5.6, 0);
  scene.add(beacon);

  const beaconLight = new THREE.PointLight(0x4cffd6, 1.6, 30, 1.6);
  beaconLight.position.set(0, 5.6, 0);
  scene.add(beaconLight);

  obstacles.cylinders.push({ x: 0, z: 0, r: 1.4 });
  return obstacles;
}

/** Atmospheric sky based on the Preetham analytic daylight model (built-in
 *  three.js example shader). Returns the sun's normalised direction so the
 *  scene's directional light can be aligned with it. */
function buildSky(scene: THREE.Scene): THREE.Vector3 {
  const sky = new Sky();
  sky.scale.setScalar(8000);
  const u = sky.material.uniforms;
  u.turbidity.value = 6;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.0035;
  u.mieDirectionalG.value = 0.78;
  // Sun position — moderate elevation, off to one side so shadows have
  // direction. azimuth 135° puts it in the front-right of the spawn view.
  const elevationDeg = 28;
  const azimuthDeg   = 135;
  const phi   = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  u.sunPosition.value.copy(sunDir);
  scene.add(sky);
  return sunDir;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
