import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { generateObstacles, terrainHeight as sharedTerrainHeight } from "./sharedObstacles";

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
/** Re-export the shared deterministic heightfield. The implementation
 *  lives in `sharedObstacles.ts` so the server's bot AI can sample the
 *  same terrain for line-of-sight checks. */
export const terrainHeight = sharedTerrainHeight;

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
  // Push the outer landscape well below the deepest river point (-6 m) so
  // it can never poke up through the translucent water plane and show as
  // a green smear over the river. From the cliff edge it's still visible
  // far in the distance as a hazy ring.
  outer.position.y = -12;
  outer.receiveShadow = true;
  addSolid(outer);

  // River water — fully opaque clear-blue ribbon along z = 0. We trade a
  // little visual depth for a clean look: any translucency lets the green
  // distant hills / outer landscape bleed through and reads to the player
  // as a "green smear above the water". Opaque + roughness near 1 +
  // metalness 0 keeps the surface a flat blue regardless of view angle.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 1.7, 70),
    new THREE.MeshStandardMaterial({
      color: 0x1d4f7a, roughness: 0.78, metalness: 0.0,
      transparent: false, opacity: 1.0,
      side: THREE.DoubleSide,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -1.0, 0);
  water.renderOrder = 2; // draw above any nearby translucent grass
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
    // Keep grass well above the waterline. Anything below ~+0.3 risks
    // poking up through the river plane (water surface y = -1, banks
    // can dip to y = -0.4 within the gaussian falloff) and reading as a
    // mysterious green smear above the water. Also skip the high rock.
    if (gy < 0.3) { i--; continue; }
    if (gy > 35) { i--; continue; }
    dummy.position.set(x, gy + 0.35, z);
    dummy.rotation.set(0, gRng() * Math.PI, 0);
    dummy.scale.set(0.7 + gRng() * 0.7, 0.6 + gRng() * 0.8, 1);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
  }
  scene.add(grass);

  // Place the shared, deterministic obstacle list (rocks / trees / shacks
  // / crates). Each obstacle's mesh is rendered here, but its collision
  // box is the same one the server uses for line-of-sight (so what you
  // see is what blocks bot shots).
  const shared = generateObstacles(half);
  // Reused materials so we only allocate once per visual variant.
  const rockMats = [
    new THREE.MeshStandardMaterial({ color: 0x6a6e74, roughness: 0.95, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.95, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x7a7a72, roughness: 0.95, flatShading: true }),
  ];
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.95 });
  const leafMats = [
    new THREE.MeshStandardMaterial({ color: 0x356a2c, roughness: 1.0, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x2c5a23, roughness: 1.0, flatShading: true }),
    new THREE.MeshStandardMaterial({ color: 0x4f7a31, roughness: 1.0, flatShading: true }),
  ];
  const shackWallMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.85 });
  const shackRoofMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xb2823c, roughness: 0.78 });

  // For obstacles on slopes we use the *minimum* terrain height around the
  // footprint corners as the placement Y. This guarantees that even on a
  // steep slope the uphill corner is still below the visible ground line
  // (instead of poking out into the air on the downhill side).
  const minCornerY = (cx: number, cz: number, hw: number, hd: number) => {
    const corners = [
      terrainHeight(cx - hw, cz - hd, half),
      terrainHeight(cx + hw, cz - hd, half),
      terrainHeight(cx - hw, cz + hd, half),
      terrainHeight(cx + hw, cz + hd, half),
      terrainHeight(cx,       cz,      half),
    ];
    return Math.min(...corners);
  };
  const maxCornerY = (cx: number, cz: number, hw: number, hd: number) => {
    return Math.max(
      terrainHeight(cx - hw, cz - hd, half),
      terrainHeight(cx + hw, cz - hd, half),
      terrainHeight(cx - hw, cz + hd, half),
      terrainHeight(cx + hw, cz + hd, half),
      terrainHeight(cx,       cz,      half),
    );
  };

  for (const o of shared) {
    if (o.type === "rock") {
      // Boulder: a flattened icosahedron with a slight non-uniform scale so
      // each rock looks unique without needing a unique geometry. We use
      // the *highest* corner of the footprint as the placement reference
      // and bury ~40% of the rock in the ground so even the uphill side
      // doesn't pop out into the air on slopes.
      const r = o.w / 2;
      const top = maxCornerY(o.x, o.z, r, r);
      const buryDepth = r * 0.45;
      const meshY = top + r * 0.7 - buryDepth;
      const rock = new THREE.Mesh(
        new THREE.IcosahedronGeometry(r, 0),
        rockMats[o.variant % rockMats.length],
      );
      rock.position.set(o.x, meshY, o.z);
      rock.scale.set(1.0 + (o.variant % 3) * 0.08, 0.7 + (o.variant % 4) * 0.05, 1.0 + (o.variant % 5) * 0.05);
      rock.rotation.y = (o.variant * 0.7) % (Math.PI * 2);
      rock.castShadow = true; rock.receiveShadow = true;
      addSolid(rock);
      // Collision box hugs the visible portion above ground.
      const baseY = top - 0.2;
      obstacles.boxes.push(new THREE.Box3(
        new THREE.Vector3(o.x - r, baseY,         o.z - r),
        new THREE.Vector3(o.x + r, baseY + r * 1.4, o.z + r),
      ));
    } else if (o.type === "tree") {
      // Simple low-poly tree: cylinder trunk + cone canopy. Trunk base is
      // pushed below the lowest corner of the trunk's footprint so the
      // root never floats off the ground on slopes.
      const trunkH = o.h * 0.55;
      const canopyH = o.h * 0.6;
      const baseY = minCornerY(o.x, o.z, 0.4, 0.4) - 0.4;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.40, trunkH, 8), trunkMat);
      trunk.position.set(o.x, baseY + trunkH / 2, o.z);
      trunk.castShadow = true; trunk.receiveShadow = true;
      addSolid(trunk);
      const canopy = new THREE.Mesh(
        new THREE.ConeGeometry(o.h * 0.35, canopyH, 8),
        leafMats[o.variant % leafMats.length],
      );
      canopy.position.set(o.x, baseY + trunkH + canopyH / 2 - 0.4, o.z);
      canopy.castShadow = true;
      scene.add(canopy); // canopy isn't a hard collider, only the trunk is
      obstacles.boxes.push(new THREE.Box3(
        new THREE.Vector3(o.x - 0.4, baseY,             o.z - 0.4),
        new THREE.Vector3(o.x + 0.4, baseY + trunkH,    o.z + 0.4),
      ));
    } else if (o.type === "shack") {
      // Box body + 4-sided pyramid roof. We anchor the *floor* to the
      // highest terrain corner (so no corner of the floor floats above
      // visible ground) and bury an extra 0.6 m beneath that so uphill
      // corners stay submerged on slopes.
      const hw = o.w / 2, hd = o.d / 2;
      const floorY = maxCornerY(o.x, o.z, hw, hd) - 0.6;
      const body = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), shackWallMat);
      body.position.set(o.x, floorY + o.h / 2, o.z);
      body.castShadow = true; body.receiveShadow = true;
      addSolid(body);
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(Math.max(o.w, o.d) * 0.75, 1.6, 4),
        shackRoofMat,
      );
      roof.position.set(o.x, floorY + o.h + 0.8, o.z);
      roof.rotation.y = Math.PI / 4; // align the 4-sided cone to the box
      roof.castShadow = true;
      scene.add(roof);
      obstacles.boxes.push(new THREE.Box3(
        new THREE.Vector3(o.x - hw, floorY,             o.z - hd),
        new THREE.Vector3(o.x + hw, floorY + o.h + 1.0, o.z + hd),
      ));
    } else { // crate
      const s = o.w;
      const baseY = maxCornerY(o.x, o.z, s / 2, s / 2) - 0.25;
      const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
      c.position.set(o.x, baseY + s * 0.5, o.z);
      c.castShadow = true; c.receiveShadow = true;
      addSolid(c);
      obstacles.boxes.push(new THREE.Box3(
        new THREE.Vector3(o.x - s / 2, baseY,     o.z - s / 2),
        new THREE.Vector3(o.x + s / 2, baseY + s, o.z + s / 2),
      ));
    }
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
