import * as THREE from "three";
import type { Room } from "colyseus.js";
import { joinArena, type ArenaStateLike, type PlayerState } from "./net/client";
import { getWeapon } from "./weapons";
import { applyMatchEvents, createEventCtx, type MatchEvents as ClientMatchEvents } from "./game/events";
import { createScene } from "./game/scene";
import { Avatar } from "./game/avatar";
import { LocalController } from "./game/controller";
import { InputManager } from "./game/input";
import { aim, spawnTracer } from "./game/shooting";
import { Sounds } from "./game/sounds";
import { Hud } from "./ui/hud";
import { setupMenu } from "./ui/menu";
import { addKillXp, load, save } from "./profile";

const host = document.getElementById("canvas-host") as HTMLDivElement;
const refs = createScene(host);

const input = new InputManager(refs.renderer.domElement, {
  joystickBase: document.getElementById("joystick-base")!,
  joystickHandle: document.getElementById("joystick-handle")!,
  joystickZone: document.getElementById("joystick-zone")!,
  lookArea: document.getElementById("look-area")!,
  fireButton: document.getElementById("fire-button")!,
  fireButtonLeft: document.getElementById("fire-button-left")!,
  aimButton: document.getElementById("aim-button")!,
  jumpButton: document.getElementById("jump-button")!,
  scoreboardButton: document.getElementById("scoreboard-button")!,
});

// Active weapon, set when the user joins the room. Defaults to rifle so any
// pre-join code paths still have a sensible weapon definition.
let weapon = getWeapon("rifle");
let magazine = weapon.magSize;

// Default aim-convergence distance (used only when the camera ray doesn't
// hit any world geometry within range — e.g. when looking at the sky).
const AIM_CONVERGE_DEFAULT = 80;
const AIM_CONVERGE_MAX = 250;
const aimRaycaster = new THREE.Raycaster();
aimRaycaster.far = AIM_CONVERGE_MAX;
const camFwdScratch = new THREE.Vector3();
const aimTargetScratch = new THREE.Vector3();
let reloading = false;
const reloadDuration = 1.6;

const hud = new Hud();
hud.setMagazine(magazine);
const sounds = new Sounds();
// Browser autoplay policy: AudioContext stays suspended until a user
// gesture, so resume on the first pointerdown anywhere on the page.
addEventListener("pointerdown", () => { /* ensureCtx is lazy */ }, { once: true });
// Track underwater state transitions to play the splash exactly once
// per crossing.
let wasUnderwater = false;

const controller = new LocalController(refs.camera, refs.arenaHalf, refs.obstacles, refs.heightAt);

// Local player avatar — visible to the local player in third-person view.
// Kept out of `avatars` so it isn't tested as a hit target. The avatar
// is *invisible* on the local client (we render in first-person), but
// we keep it around for two reasons:
//   1. It still positions the gun rig in world space so the muzzle
//      position calculation continues to work.
//   2. Other players see remote-replicated copies of *their* avatars,
//      not this one — the local model would otherwise crowd the FPS
//      view by appearing right in front of the camera.
const localAvatar = new Avatar("You", load().skin);
localAvatar.setVisible(false);
localAvatar.setLaserVisible(false);
refs.scene.add(localAvatar.group);

// FPS viewmodel — a small, low-poly gun rendered as a child of the camera
// so it's always visible at the bottom-right of the player's view. We add
// the camera to the scene so its children render. Position is in *camera
// space*: x=right, y=up, z=back (camera looks down -Z).
refs.scene.add(refs.camera);
const viewModel = new THREE.Group();
{
  const matBody = new THREE.MeshStandardMaterial({ color: 0x202533, roughness: 0.6, metalness: 0.2 });
  const matAccent = new THREE.MeshStandardMaterial({ color: 0x404654, roughness: 0.5, metalness: 0.3 });
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.13, 0.30), matBody);
  stock.position.set(0, 0, 0.13);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.18, 0.45), matBody);
  body.position.set(0, 0.02, -0.10);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.55), matAccent);
  barrel.position.set(0, 0.05, -0.50);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.10), matBody);
  grip.position.set(0, -0.10, 0.00);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.18, 0.08), matAccent);
  mag.position.set(0, -0.16, -0.08);
  for (const m of [stock, body, barrel, grip, mag]) {
    m.castShadow = false;
    m.receiveShadow = false;
    viewModel.add(m);
  }
}
viewModel.position.set(0.28, -0.24, -0.55);
viewModel.rotation.set(-0.04, -0.05, 0);
refs.camera.add(viewModel);

// FOV transition is driven by the controller's aimBlend so camera distance,
// shoulder offset, look-sensitivity, and FOV all blend in lockstep.

// Match-events context (night, fog, meteor shower, low gravity). Initialised
// after the scene is built so we can snapshot the original light intensities.
const eventCtx = createEventCtx(refs.scene);
const eventState: ClientMatchEvents = {
  night: false, lowGravity: false, meteorShower: false, fog: false,
  thunderstorm: false, sandstorm: false,
};

let room: Room<ArenaStateLike> | null = null;
const avatars = new Map<string, Avatar>();
const tracers: Array<(dt: number) => boolean> = [];
let lastShotAt = 0;

const menu = setupMenu(async ({ name, skin, weapon: weaponId, createMatch, match }) => {
  menu.setStatus("Connecting…");
  try {
    weapon = getWeapon(weaponId);
    magazine = weapon.magSize;
    hud.setMagazine(magazine);
    localAvatar.setSkin(skin);
    room = await joinArena({
      name, skin, weapon: weaponId, createMatch,
      bots: match.bots,
      events: match.events,
    });
    bindRoom(room);
    document.getElementById("hud")!.classList.remove("hidden");
    menu.hide();
    if (!isTouchDevice()) input.requestPointerLock();
    // Mobile fullscreen + orientation lock is requested synchronously inside
    // the menu's click handler so the browser accepts the user gesture.
  } catch (e: any) {
    console.error(e);
    menu.setStatus(`Failed to join: ${e?.message ?? e}`);
  }
});

function bindRoom(r: Room<ArenaStateLike>) {
  hud.bind(r, r.sessionId);

  r.state.players.onAdd((p: PlayerState, id: string) => {
    if (id === r.sessionId) {
      controller.setPosition(p.x, p.y, p.z);
      // Watch our own state so respawns (server picks a new spawn point and
      // resets hp to 100) actually teleport the camera to the new position.
      let prevHp = p.hp;
      (p as any).onChange?.(() => {
        if (prevHp <= 0 && p.hp > 0) {
          controller.setPosition(p.x, p.y, p.z);
        }
        prevHp = p.hp;
      });
      return;
    }
    // Defensive: never create a remote avatar for ourselves. Without this
    // a clone of the local player would appear and exactly mirror our
    // movement, since the server reflects our own state back to us.
    if (id === r.sessionId) return;
    const av = new Avatar(p.name, p.skin);
    // Snap remote players to local terrain so they don't appear floating.
    // The server doesn't know about the heightfield (it just clamps Y to a
    // safe range), so for *bots* — which never simulate gravity client-side
    // — we always pin to ground level. For human remote players we still
    // allow the server's Y to win when it's higher than the ground (so
    // jumps replicate), but only by a small clearance.
    const snapY = (x: number, y: number, z: number, isBot: boolean) => {
      const ground = refs.heightAt(x, z) + 1.6;
      return isBot ? ground : Math.max(y, ground);
    };
    av.setPose(p.x, snapY(p.x, p.y, p.z, !!p.isBot), p.z, p.yaw, p.pitch);
    av.setVisible(p.hp > 0);
    refs.scene.add(av.group);
    avatars.set(id, av);
    // Schema 2.x style: onChange is a method that returns an unsubscribe fn.
    const sync = () => {
      av.setPose(p.x, snapY(p.x, p.y, p.z, !!p.isBot), p.z, p.yaw, p.pitch);
      av.setVisible(p.hp > 0);
    };
    (p as any).onChange?.(sync);
  });

  r.state.players.onRemove((_p: PlayerState, id: string) => {
    const av = avatars.get(id);
    if (av) { refs.scene.remove(av.group); avatars.delete(id); }
  });

  r.onMessage("kill", (msg: { attacker: string; victim: string }) => {
    if (msg.attacker === r.sessionId) {
      const profile = load();
      addKillXp(profile);
      save(profile);
    }
  });
}

let lastFrame = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  const i = input.consume();
  controller.update(dt, i);

  let alive = true;
  if (room) {
    const me = room.state.players.get(room.sessionId);
    if (me) {
      hud.setHp(me.hp);
      hud.setOxygen(controller.oxygenFraction(), controller.isUnderwater);
      alive = me.hp > 0;
      // Local avatar stays hidden in FPS view; only the remote-replicated
      // copy that other players see needs to reflect aliveness.
      localAvatar.setSkin(me.skin);
      if (alive) {
        // Push position to server every frame; server clamps and reflects state.
        room.send("move", {
          x: controller.position.x,
          y: controller.position.y,
          z: controller.position.z,
          yaw: controller.yaw,
          pitch: controller.pitch,
        });
        // Forward any drown damage accumulated this frame so the server
        // applies it authoritatively (HP must not be set client-side).
        const drown = controller.consumeDrownDamage();
        if (drown > 0) room.send("selfDamage", { amount: drown, cause: "drown" });
      }
    }
    hud.refreshScoreboard(room.state);
  }
  // Sync the local avatar to the controller every frame.
  localAvatar.setPose(
    controller.position.x,
    controller.position.y,
    controller.position.z,
    controller.yaw,
    controller.pitch,
  );

  // Convergent aim: rotate the gun (and its laser) so the barrel points at
  // the same world point that the camera-centred crosshair is looking at.
  // Without this, the camera sits behind/right of the player while the gun
  // points purely along player.yaw — bullets land where the crosshair is
  // (camera ray) but the laser shows the parallel-shifted gun-yaw axis,
  // confusing the user. With convergence: laser, gun, crosshair, and bullet
  // path all meet at the same target point.
  // Find the actual world point the camera-centred crosshair is pointing
  // at by raycasting against the ground + obstacle meshes. This ensures
  // the gun, laser, and bullet path converge on the *real* hit point at
  // any distance — not just at a fixed 30 m, which would put bullets off-
  // crosshair at long range due to the lateral camera/gun parallax.
  refs.camera.getWorldDirection(camFwdScratch);
  aimRaycaster.set(refs.camera.position, camFwdScratch);
  const hits = aimRaycaster.intersectObjects(refs.aimMeshes, false);
  let convergeDist = AIM_CONVERGE_DEFAULT;
  for (const h of hits) {
    if (h.distance > 1.0) { convergeDist = h.distance; break; }
  }
  aimTargetScratch
    .copy(refs.camera.position)
    .addScaledVector(camFwdScratch, convergeDist);
  localAvatar.setAimTarget(aimTargetScratch);

  // Keep the directional shadow camera centred on the active player so
  // shadows render correctly across the whole 600 m map.
  refs.followSun(controller.position.x, controller.position.z);

  // Pull the match events from the room state and apply diffs once per
  // frame so toggle-on/off are idempotent.
  if (room?.state?.events) {
    eventState.night = !!room.state.events.night;
    eventState.lowGravity = !!room.state.events.lowGravity;
    eventState.meteorShower = !!room.state.events.meteorShower;
    eventState.fog = !!room.state.events.fog;
    eventState.thunderstorm = !!room.state.events.thunderstorm;
    eventState.sandstorm = !!room.state.events.sandstorm;
  }
  applyMatchEvents(eventState, eventCtx, refs, controller, dt, {
    onLightning: () => sounds.playThunder(),
  });

  if (i.toggleScoreboard) hud.toggleScoreboard();

  // Aim-down-sights: FOV and laser-sight track the controller's aim blend.
  const aimAmt = alive ? controller.aimBlend : 0;
  const baseFov = refs.getBaseFov();
  const adsFov = baseFov * 0.55;
  refs.camera.fov = baseFov + (adsFov - baseFov) * aimAmt;
  refs.camera.updateProjectionMatrix();
  localAvatar.setLaserVisible(false);

  // Slide the viewmodel toward the centre/forward when aiming so the
  // gun lines up under the crosshair, then back to the rest hip pose.
  const vmHipX = 0.28, vmHipY = -0.24, vmHipZ = -0.55;
  const vmAdsX = 0.00, vmAdsY = -0.13, vmAdsZ = -0.42;
  viewModel.position.set(
    vmHipX + (vmAdsX - vmHipX) * aimAmt,
    vmHipY + (vmAdsY - vmHipY) * aimAmt,
    vmHipZ + (vmAdsZ - vmHipZ) * aimAmt,
  );

  // Shooting (no firing while dead). Cadence and pellet count come from
  // the active weapon, so swapping rifle ↔ shotgun ↔ sniper changes the
  // feel of every trigger pull.
  if (alive && i.fireHeld && !reloading && magazine > 0 && performance.now() - lastShotAt > weapon.fireRateMs) {
    lastShotAt = performance.now();
    magazine -= 1;
    hud.setMagazine(magazine);
    // Per-weapon recoil. The controller absorbs the kick and lets it bleed
    // back over ~180 ms, so the player sees the camera jolt up + slightly
    // sideways and can compensate by pulling down on touch / mouse.
    controller.applyRecoil(weapon.recoil);
    sounds.playShot(weapon.id);
    // Spawn tracer from the *visible* barrel tip (rotated by the convergent
    // aim) so the user sees bullets fly from where their gun is pointing,
    // not from a yaw-only approximation behind/below the actual barrel.
    const muzzle = localAvatar.getBarrelTipWorld();
    const baseDir = aimTargetScratch.clone().sub(muzzle).normalize();
    // Shotguns fire several pellets in a cone; rifles/snipers fire one
    // perfectly along the camera ray. Each pellet that hits a target needs
    // its own `shoot` message so the server applies damage per pellet —
    // deduplicating to one message per target would cap the shotgun at a
    // single pellet's damage even on a point-blank hit (Devin Review
    // BUG_0002).
    const pelletHits: Record<string, number> = {};
    for (let pellet = 0; pellet < weapon.pellets; pellet++) {
      const dir = weapon.spread > 0 ? jitterDir(baseDir, weapon.spread) : baseDir;
      const result = aim(muzzle, dir, avatars, weapon.maxRange);
      tracers.push(spawnTracer(refs.scene, refs.camera, muzzle, result.point, weapon.tracerColor, weapon.tracerWidth));
      if (result.targetId) pelletHits[result.targetId] = (pelletHits[result.targetId] ?? 0) + 1;
    }
    if (room) {
      for (const [targetId, count] of Object.entries(pelletHits)) {
        for (let n = 0; n < count; n++) room.send("shoot", { targetId });
      }
      if (Object.keys(pelletHits).length > 0) sounds.playHit();
    }
    if (magazine === 0) startReload();
  }

  // Per-frame audio: footsteps + underwater filter switch + splash on
  // entering/leaving water.
  if (alive) {
    const horizSpeed = Math.hypot(controller.velX, controller.velZ);
    sounds.tickFootsteps(horizSpeed, dt, controller.grounded, controller.isUnderwater);
  }
  if (controller.isUnderwater !== wasUnderwater) {
    sounds.setUnderwater(controller.isUnderwater);
    sounds.playSplash();
    wasUnderwater = controller.isUnderwater;
  }

  // Tracer cleanup
  for (let k = tracers.length - 1; k >= 0; k--) {
    if (!tracers[k](dt)) tracers.splice(k, 1);
  }

  refs.renderer.render(refs.scene, refs.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function startReload() {
  if (reloading) return;
  reloading = true;
  hud.setMagazine(0);
  sounds.playReload();
  setTimeout(() => {
    magazine = weapon.magSize;
    reloading = false;
    hud.setMagazine(magazine);
  }, weapon.reloadMs);
}

/** Returns a unit vector close to `dir` rotated by a random offset within
 *  a cone of half-angle `spread` (radians). Used by the shotgun. */
function jitterDir(dir: THREE.Vector3, spread: number): THREE.Vector3 {
  // Build an orthonormal basis around dir, then offset within the disk.
  const up = Math.abs(dir.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(dir, up).normalize();
  const u = new THREE.Vector3().crossVectors(right, dir).normalize();
  const ang = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spread;
  return dir.clone()
    .addScaledVector(right, Math.cos(ang) * r)
    .addScaledVector(u, Math.sin(ang) * r)
    .normalize();
}

function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

// Click anywhere on canvas re-locks the pointer on desktop.
refs.renderer.domElement.addEventListener("click", () => {
  if (!isTouchDevice() && room) input.requestPointerLock();
});

// Manual reload (R on desktop)
addEventListener("keydown", (e) => { if (e.code === "KeyR") startReload(); });
