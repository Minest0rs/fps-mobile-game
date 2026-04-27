import * as THREE from "three";

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
  /** The non-zoomed FOV the camera was last fit to (responsive to viewport). */
  getBaseFov: () => number;
}

/** Build the renderer, camera, lights, sky, ground, walls, and crates. */
export function createScene(host: HTMLElement): SceneRefs {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2640);
  scene.fog = new THREE.Fog(0x1a2640, 80, 220);
  buildSky(scene);

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

  // "Sun" — main shadow caster with warm tint.
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.5);
  sun.position.set(22, 30, 14);
  sun.castShadow = true;
  sun.shadow.camera.left = -55; sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55; sun.shadow.camera.bottom = -55;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 140;
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

  const arenaHalf = 40;
  const obstacles = buildArena(scene, arenaHalf);

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

  return { scene, camera, renderer, arenaHalf, obstacles, getBaseFov: () => baseFov };
}

function buildArena(scene: THREE.Scene, half: number): Obstacles {
  const obstacles: Obstacles = { boxes: [], cylinders: [] };
  // Ground — lighter so the sun's directional light reads clearly.
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x36405a, roughness: 0.9, metalness: 0.1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Outer "landscape" — a much larger ground plane behind the play-area
  // walls so the horizon doesn't end at the arena bounds. Slightly darker.
  const outer = new THREE.Mesh(
    new THREE.PlaneGeometry(half * 8, half * 8),
    new THREE.MeshStandardMaterial({ color: 0x232a44, roughness: 0.95 }),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.01;
  outer.receiveShadow = true;
  scene.add(outer);

  // Distant decorative hills around the arena (no collision; just horizon
  // dressing) so the world reads as a real place rather than a flat plane.
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x2c3656, roughness: 1.0 });
  const hillRng = mulberry32(909);
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * Math.PI * 2 + hillRng() * 0.4;
    const dist = half * 1.6 + hillRng() * half * 1.5;
    const h = 6 + hillRng() * 14;
    const r = 6 + hillRng() * 10;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), hillMat);
    cone.position.set(Math.cos(angle) * dist, h / 2 - 0.5, Math.sin(angle) * dist);
    cone.rotation.y = hillRng() * Math.PI;
    scene.add(cone);
  }

  // Grid overlay
  const grid = new THREE.GridHelper(half * 2, 40, 0x6e7da3, 0x4a5775);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.45;
  scene.add(grid);

  // Walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a577a, roughness: 0.6, metalness: 0.25 });
  const mkBox = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material = wallMat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    obstacles.boxes.push(new THREE.Box3(
      new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2),
    ));
  };
  // Boundary walls
  mkBox(half * 2, 5, 0.8, 0, 2.5, half);
  mkBox(half * 2, 5, 0.8, 0, 2.5, -half);
  mkBox(0.8, 5, half * 2, half, 2.5, 0);
  mkBox(0.8, 5, half * 2, -half, 2.5, 0);

  // Cover bunkers — short L-shaped walls scattered around so there are
  // sight-lines to break up at long range.
  const bunkerMat = new THREE.MeshStandardMaterial({ color: 0x3d4a6c, roughness: 0.85 });
  const bunkers: Array<[number, number, number]> = [
    [-22, 0,  18], [ 22, 0, -18],
    [ 18, 0,  22], [-18, 0, -22],
    [-30, 0, -8],  [ 30, 0,  8],
    [  0, 0,  30], [  0, 0, -30],
  ];
  for (const [bx, _by, bz] of bunkers) {
    mkBox(8, 2.2, 0.7, bx,     1.1, bz, bunkerMat);
    mkBox(0.7, 2.2, 6, bx + 4, 1.1, bz - 3, bunkerMat);
  }

  // Crates — deterministic positions so all clients see the same layout.
  const rng = mulberry32(1337);
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xb2823c, roughness: 0.78 });
  for (let i = 0; i < 36; i++) {
    const s = 1.2 + rng() * 1.4;
    const px = (rng() * 2 - 1) * (half - 2);
    const pz = (rng() * 2 - 1) * (half - 2);
    // Avoid spawning crates on top of the center pillar.
    if (px * px + pz * pz < 16) { i--; continue; }
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
    c.position.set(px, s * 0.5, pz);
    c.castShadow = true; c.receiveShadow = true;
    scene.add(c);
    obstacles.boxes.push(new THREE.Box3(
      new THREE.Vector3(px - s / 2, 0,     pz - s / 2),
      new THREE.Vector3(px + s / 2, s,     pz + s / 2),
    ));
  }

  // A few taller "tower" blocks players can use as cover and jump up to.
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x52628a, roughness: 0.5, metalness: 0.3 });
  const towers: Array<[number, number]> = [
    [-12,  12], [ 12, -12], [-26,  0], [ 26, 0], [ 0, 24], [ 0, -24],
  ];
  for (const [tx, tz] of towers) {
    mkBox(3, 1.4, 3, tx, 0.7, tz, towerMat);
  }

  // Center pillar with a glowing top so the middle of the arena is a landmark.
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 5, 24),
    new THREE.MeshStandardMaterial({ color: 0x6478a8, roughness: 0.4, metalness: 0.5 }),
  );
  pillar.position.set(0, 2.5, 0);
  pillar.castShadow = true; pillar.receiveShadow = true;
  scene.add(pillar);

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

/** A large inverted sphere with a vertex-shader gradient that fakes a sky:
 *  zenith → horizon → ground colour. Uses BackSide so the camera sees the
 *  inside surface, and depth-disabled so it always sits behind everything. */
function buildSky(scene: THREE.Scene) {
  const geom = new THREE.SphereGeometry(500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor:    { value: new THREE.Color(0x1d3a78) },
      midColor:    { value: new THREE.Color(0x6892c8) },
      bottomColor: { value: new THREE.Color(0xe5b585) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vWorld = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 bottomColor;
      varying vec3 vWorld;
      void main() {
        float h = clamp(vWorld.y, -1.0, 1.0);
        vec3 col = h > 0.0
          ? mix(midColor, topColor, pow(h, 0.7))
          : mix(midColor, bottomColor, pow(-h, 0.6));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geom, mat);
  // Render before everything else so it acts as a backdrop.
  mesh.renderOrder = -1;
  scene.add(mesh);
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
