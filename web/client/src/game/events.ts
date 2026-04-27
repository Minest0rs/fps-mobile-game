import * as THREE from "three";
import type { SceneRefs } from "./scene";
import type { LocalController } from "./controller";

export interface MatchEvents {
  night: boolean;
  lowGravity: boolean;
  meteorShower: boolean;
  fog: boolean;
  thunderstorm: boolean;
  sandstorm: boolean;
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
  /** Original light colours so events can restore the exact scene setup
   *  values rather than hardcoded constants that drift out of sync. */
  origAmbientColor: number;
  origSunColor: number;
  /** Cached references. */
  ambient: THREE.HemisphereLight | null;
  sun: THREE.DirectionalLight | null;
  /** Thunderstorm: counter that triggers a screen-flash + ambient kick at
   *  random intervals while the event is active. */
  nextLightningAt: number;
  lightningFlashFor: number;
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
    applied: {
      night: false, lowGravity: false, meteorShower: false, fog: false,
      thunderstorm: false, sandstorm: false,
    },
    meteors: [],
    meteorAcc: 0,
    origAmbient: lights.ambient?.intensity ?? 1.0,
    origSun: lights.sun?.intensity ?? 1.5,
    origAmbientColor: lights.ambient?.color.getHex() ?? 0xbcd6ff,
    origSunColor: lights.sun?.color.getHex() ?? 0xfff1d6,
    ambient: lights.ambient,
    sun: lights.sun,
    nextLightningAt: 0,
    lightningFlashFor: 0,
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
    if (ctx.sun) ctx.sun.color.setHex(events.night ? 0x6f8aff : ctx.origSunColor);
    // Hide the daylight Sky mesh during night so scene.background paints
    // the horizon dark. Self-assigning would leave the dark background in
    // place permanently (Devin Review BUG_0001).
    if (events.night) {
      refs.sky.visible = false;
      refs.scene.background = new THREE.Color(0x07091a);
    } else if (!events.thunderstorm && !events.sandstorm) {
      refs.sky.visible = true;
      refs.scene.background = null;
    }
  }

  // --- Fog (heavier than the default haze) ---
  // Note: Fog and Sandstorm both write to scene.fog. Since the server
  // scheduler only ever runs one event at a time, they don't conflict;
  // when either turns off we restore the default haze.
  if (events.fog !== ctx.applied.fog) {
    if (events.fog) {
      refs.scene.fog = new THREE.Fog(0x9aa9b8, 30, 220);
    } else if (!events.sandstorm) {
      refs.scene.fog = new THREE.Fog(0xc4d4e6, 200, 700);
    }
  }

  // --- Sandstorm (very thick yellow-tinted fog) ---
  if (events.sandstorm !== ctx.applied.sandstorm) {
    if (events.sandstorm) {
      refs.scene.fog = new THREE.Fog(0xc8a35a, 12, 110);
      if (ctx.ambient) ctx.ambient.color.setHex(0xd5a96a);
      // The Sky shader paints a blue daylight sky regardless of fog —
      // hide it during sandstorm and paint the scene background sandy
      // yellow so the horizon blends with the dust fog.
      refs.sky.visible = false;
      refs.scene.background = new THREE.Color(0xc8a35a);
    } else {
      if (!events.fog) refs.scene.fog = new THREE.Fog(0xc4d4e6, 200, 700);
      if (ctx.ambient) ctx.ambient.color.setHex(ctx.origAmbientColor);
      // Restore the daylight sky unless another event needs it hidden.
      if (!events.thunderstorm && !events.night) {
        refs.sky.visible = true;
        refs.scene.background = null;
      }
    }
  }

  // --- Thunderstorm: random lightning flashes + darkened sky ---
  if (events.thunderstorm !== ctx.applied.thunderstorm) {
    if (events.thunderstorm) {
      // Darken the sky to a stormy slate. Sun goes cool/dim.
      refs.sky.visible = false;
      refs.scene.background = new THREE.Color(0x1a2230);
      if (ctx.sun) ctx.sun.intensity = ctx.origSun * 0.35;
      if (ctx.ambient) ctx.ambient.intensity = ctx.origAmbient * 0.55;
      ctx.nextLightningAt = performance.now() / 1000 + 1 + Math.random() * 4;
    } else {
      // Restore (unless night/sandstorm is also on).
      if (!events.night && !events.sandstorm) {
        refs.sky.visible = true;
        refs.scene.background = null;
      }
      if (ctx.sun) ctx.sun.intensity = events.night ? ctx.origSun * 0.20 : ctx.origSun;
      if (ctx.ambient) ctx.ambient.intensity = events.night ? ctx.origAmbient * 0.18 : ctx.origAmbient;
      ctx.lightningFlashFor = 0;
    }
  }
  if (events.thunderstorm) {
    const t = performance.now() / 1000;
    if (t >= ctx.nextLightningAt) {
      ctx.lightningFlashFor = 0.18; // half-second flash with quick decay
      ctx.nextLightningAt = t + 2.5 + Math.random() * 6;
    }
    if (ctx.lightningFlashFor > 0) {
      ctx.lightningFlashFor = Math.max(0, ctx.lightningFlashFor - dt);
      const flashAmt = ctx.lightningFlashFor / 0.18;
      if (ctx.sun) ctx.sun.intensity = ctx.origSun * (0.35 + 2.4 * flashAmt);
      if (ctx.ambient) ctx.ambient.intensity = ctx.origAmbient * (0.55 + 2.0 * flashAmt);
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
