import * as THREE from "three";

export interface SceneRefs {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  arenaHalf: number;
}

/** Build the renderer, camera, lights, sky, ground, walls, and crates. */
export function createScene(host: HTMLElement): SceneRefs {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2640);
  scene.fog = new THREE.Fog(0x1a2640, 40, 120);

  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
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
  renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight), false);
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
  sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
  sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 80;
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
    [0xff4c6e,  14, 6,  14],
    [0x4cffd6, -14, 6,  14],
    [0x9d6bff,  14, 6, -14],
    [0xffd66e, -14, 6, -14],
  ];
  for (const [color, x, y, z] of accents) {
    const pl = new THREE.PointLight(color, 0.9, 22, 1.6);
    pl.position.set(x, y, z);
    scene.add(pl);
  }

  const arenaHalf = 19;
  buildArena(scene, arenaHalf);

  const fit = () => {
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", fit);
  // ResizeObserver catches container changes that aren't window resizes
  // (e.g. browser chrome appearing on mobile, fullscreen toggles).
  new ResizeObserver(fit).observe(host);
  fit();

  return { scene, camera, renderer, arenaHalf };
}

function buildArena(scene: THREE.Scene, half: number) {
  // Ground — lighter so the sun's directional light reads clearly.
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x36405a, roughness: 0.9, metalness: 0.1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Grid overlay
  const grid = new THREE.GridHelper(half * 2, 20, 0x6e7da3, 0x4a5775);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.55;
  scene.add(grid);

  // Walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a577a, roughness: 0.6, metalness: 0.25 });
  const mkWall = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  };
  mkWall(half * 2, 4, 0.6, 0, 2, half);
  mkWall(half * 2, 4, 0.6, 0, 2, -half);
  mkWall(0.6, 4, half * 2, half, 2, 0);
  mkWall(0.6, 4, half * 2, -half, 2, 0);

  // Crates — deterministic positions so all clients see the same layout.
  const rng = mulberry32(1337);
  const crateMat = new THREE.MeshStandardMaterial({ color: 0xb2823c, roughness: 0.78 });
  for (let i = 0; i < 14; i++) {
    const s = 1.4 + rng() * 1.2;
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
    c.position.set(
      (rng() * 2 - 1) * (half - 2),
      s * 0.5,
      (rng() * 2 - 1) * (half - 2),
    );
    c.castShadow = true; c.receiveShadow = true;
    scene.add(c);
  }

  // Center pillar with a glowing top so the middle of the arena is a landmark.
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 4, 24),
    new THREE.MeshStandardMaterial({ color: 0x6478a8, roughness: 0.4, metalness: 0.5 }),
  );
  pillar.position.set(0, 2, 0);
  pillar.castShadow = true; pillar.receiveShadow = true;
  scene.add(pillar);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.6, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x4cffd6, emissiveIntensity: 2.5,
      roughness: 0.2, metalness: 0.0,
    }),
  );
  beacon.position.set(0, 4.6, 0);
  scene.add(beacon);

  const beaconLight = new THREE.PointLight(0x4cffd6, 1.4, 18, 1.6);
  beaconLight.position.set(0, 4.6, 0);
  scene.add(beaconLight);
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
