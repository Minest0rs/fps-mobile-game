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
  scene.background = new THREE.Color(0x0b0d12);
  scene.fog = new THREE.Fog(0x0b0d12, 25, 80);

  const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const ambient = new THREE.HemisphereLight(0x88aaff, 0x0a0d18, 0.45);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.0);
  sun.position.set(20, 30, 14);
  sun.castShadow = true;
  sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

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
  // Ground
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.95, metalness: 0.1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Grid overlay
  const grid = new THREE.GridHelper(half * 2, 20, 0x2a3550, 0x1a2030);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.4;
  scene.add(grid);

  // Walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x303a55, roughness: 0.7, metalness: 0.2 });
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
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x6c512a, roughness: 0.85 });
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

  // Center pillar
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 4, 16),
    new THREE.MeshStandardMaterial({ color: 0x44557a, roughness: 0.5, metalness: 0.4 }),
  );
  pillar.position.set(0, 2, 0);
  pillar.castShadow = true; pillar.receiveShadow = true;
  scene.add(pillar);
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
