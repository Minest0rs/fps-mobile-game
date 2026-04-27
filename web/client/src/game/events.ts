import * as THREE from "three";
import type { SceneRefs } from "./scene";
import type { LocalController } from "./controller";

export interface MatchEvents {
  night: boolean;
  lowGravity: boolean;
  meteorShower: boolean;
  fog: boolean;
}

/** State for client-side match-event effects. We apply changes once when an
 *  event becomes active and unwind them when it deactivates so the scene
 *  doesn't get permanently darkened/foggy after a match ends. */
export interface EventCtx {
  /** Most recent applied state — drives diffing. */
  applied: MatchEvents;
  /** Active meteors (visual-only). */
  meteors: Array<{ mesh: THREE.Mesh; vy: number; aliveFor: number }>;
  /** Time accumulator for spawning meteors. */
  meteorAcc: number;
  /** Original ambient/sun intensities so night mode can restore them. */
  origAmbient: number;
  origSun: number;
  /** Cached references. */
  ambient: THREE.HemisphereLight | null;
  sun: THREE.DirectionalLight | null;
}

export function createEventCtx(scene: THREE.Scene): EventCtx {
  // Snapshot the existing primary lights so we can adjust intensities for
  // night mode and restore them when night turns off.
  const lights: { ambient: THREE.HemisphereLight | null; sun: THREE.DirectionalLight | null } = {
    ambient: null, sun: null,
  };
  scene.traverse((o) => {
    const obj = o as THREE.Object3D & { isHemisphereLight?: boolean; isDirectionalLight?: boolean };
    if (!lights.ambient && obj.isHemisphereLight) lights.ambient = obj as unknown as THREE.HemisphereLight;
    if (!lights.sun && obj.isDirectionalLight) lights.sun = obj as unknown as THREE.DirectionalLight;
  });
  return {
    applied: { night: false, lowGravity: false, meteorShower: false, fog: false },
    meteors: [],
    meteorAcc: 0,
    origAmbient: lights.ambient?.intensity ?? 1.0,
    origSun: lights.sun?.intensity ?? 1.5,
    ambient: lights.ambient,
    sun: lights.sun,
  };
}

const NORMAL_GRAVITY = -22;
const LOW_GRAVITY = -7;

/** Apply / un-apply event modifiers to the scene + controller every frame.
 *  `events` is the authoritative server value; the client computes a diff
 *  against `ctx.applied` so toggle-on / toggle-off effects only run once. */
export function applyMatchEvents(
  events: MatchEvents,
  ctx: EventCtx,
  refs: SceneRefs,
  controller: LocalController,
  dt: number,
) {
  // --- Night ---
  if (events.night !== ctx.applied.night) {
    if (ctx.ambient) ctx.ambient.intensity = events.night ? ctx.origAmbient * 0.18 : ctx.origAmbient;
    if (ctx.sun) ctx.sun.intensity = events.night ? ctx.origSun * 0.20 : ctx.origSun;
    if (ctx.sun) ctx.sun.color.setHex(events.night ? 0x6f8aff : 0xfff1d1);
    refs.scene.background = events.night
      ? new THREE.Color(0x07091a)
      : refs.scene.background; // sky shader stays on; we just darken bg if used.
  }

  // --- Fog (heavier than the default haze) ---
  if (events.fog !== ctx.applied.fog) {
    if (events.fog) {
      refs.scene.fog = new THREE.Fog(0x9aa9b8, 30, 220);
    } else {
      refs.scene.fog = new THREE.Fog(0xc4d4e6, 200, 700);
    }
  }

  // --- Low gravity ---
  if (events.lowGravity !== ctx.applied.lowGravity) {
    controller.gravity = events.lowGravity ? LOW_GRAVITY : NORMAL_GRAVITY;
  }

  // --- Meteor shower (purely visual) ---
  if (events.meteorShower) {
    ctx.meteorAcc += dt;
    // Spawn rate scales mildly with map area — a few per second, falling
    // from above the cliff line.
    while (ctx.meteorAcc > 0.35) {
      ctx.meteorAcc -= 0.35;
      spawnMeteor(refs, ctx, controller);
    }
    // Step active meteors.
    for (let i = ctx.meteors.length - 1; i >= 0; i--) {
      const m = ctx.meteors[i];
      m.aliveFor += dt;
      m.vy += -28 * dt; // accelerate downward
      m.mesh.position.y += m.vy * dt;
      m.mesh.rotation.x += dt * 4;
      m.mesh.rotation.z += dt * 3;
      // Fade trail glow over life so meteors don't accumulate.
      const ground = refs.heightAt(m.mesh.position.x, m.mesh.position.z);
      if (m.mesh.position.y < ground - 1 || m.aliveFor > 6) {
        // Brief impact flash.
        spawnMeteorImpact(refs.scene, m.mesh.position.x, ground + 0.5, m.mesh.position.z);
        refs.scene.remove(m.mesh);
        (m.mesh.material as THREE.Material).dispose();
        m.mesh.geometry.dispose();
        ctx.meteors.splice(i, 1);
      }
    }
  } else if (ctx.meteors.length > 0 && !events.meteorShower) {
    // Clean up any in-flight meteors when the event turns off.
    for (const m of ctx.meteors) {
      refs.scene.remove(m.mesh);
      (m.mesh.material as THREE.Material).dispose();
      m.mesh.geometry.dispose();
    }
    ctx.meteors.length = 0;
  }

  ctx.applied = { ...events };
}

function spawnMeteor(refs: SceneRefs, ctx: EventCtx, controller: LocalController) {
  const radius = 0.6 + Math.random() * 1.2;
  const geom = new THREE.IcosahedronGeometry(radius, 0);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x261006, emissive: 0xff5a1a, emissiveIntensity: 1.6,
    roughness: 0.85, metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geom, mat);
  // Spawn within ~150m of the player, falling from 80m above.
  const r = 60 + Math.random() * 90;
  const ang = Math.random() * Math.PI * 2;
  mesh.position.set(
    controller.position.x + Math.cos(ang) * r,
    80 + Math.random() * 20,
    controller.position.z + Math.sin(ang) * r,
  );
  refs.scene.add(mesh);
  ctx.meteors.push({ mesh, vy: -10, aliveFor: 0 });
}

function spawnMeteorImpact(scene: THREE.Scene, x: number, y: number, z: number) {
  const g = new THREE.SphereGeometry(2, 14, 10);
  const m = new THREE.MeshBasicMaterial({
    color: 0xffae5a, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const flash = new THREE.Mesh(g, m);
  flash.position.set(x, y, z);
  scene.add(flash);
  let t = 0;
  const tick = () => {
    t += 0.05;
    m.opacity = Math.max(0, 0.9 * (1 - t / 0.6));
    flash.scale.setScalar(1 + t * 4);
    if (t < 0.6) requestAnimationFrame(tick);
    else { scene.remove(flash); g.dispose(); m.dispose(); }
  };
  tick();
}
