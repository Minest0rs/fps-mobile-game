import * as THREE from "three";
import type { Room } from "colyseus.js";
import { joinArena, type ArenaStateLike, type PlayerState } from "./net/client";
import { createScene } from "./game/scene";
import { Avatar } from "./game/avatar";
import { LocalController } from "./game/controller";
import { InputManager } from "./game/input";
import { aim, spawnTracer } from "./game/shooting";
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

const magazineSize = 30;
let magazine = magazineSize;

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

const controller = new LocalController(refs.camera, refs.arenaHalf, refs.obstacles, refs.heightAt);

// Local player avatar — visible to the local player in third-person view.
// Kept out of `avatars` so it isn't tested as a hit target.
const localAvatar = new Avatar("You", load().skin);
localAvatar.setVisible(true);
// The laser sight only shows while aiming so it isn't visual clutter every
// frame.
localAvatar.setLaserVisible(false);
refs.scene.add(localAvatar.group);

// FOV transition is driven by the controller's aimBlend so camera distance,
// shoulder offset, look-sensitivity, and FOV all blend in lockstep.

let room: Room<ArenaStateLike> | null = null;
const avatars = new Map<string, Avatar>();
const tracers: Array<(dt: number) => boolean> = [];
let lastShotAt = 0;
const shotIntervalMs = 110;

const menu = setupMenu(async ({ name, skin }) => {
  menu.setStatus("Connecting…");
  try {
    room = await joinArena(name, skin);
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
    // Snap remote players to local terrain so they don't appear floating
    // (the server doesn't know about the heightfield, so it sends y = 5
    // for fresh spawns regardless of the actual ground at (x, z)).
    const snapY = (x: number, y: number, z: number) =>
      Math.max(y, refs.heightAt(x, z) + 1.6);
    av.setPose(p.x, snapY(p.x, p.y, p.z), p.z, p.yaw, p.pitch);
    av.setVisible(p.hp > 0);
    refs.scene.add(av.group);
    avatars.set(id, av);
    // Schema 2.x style: onChange is a method that returns an unsubscribe fn.
    const sync = () => {
      av.setPose(p.x, snapY(p.x, p.y, p.z), p.z, p.yaw, p.pitch);
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
      alive = me.hp > 0;
      localAvatar.setVisible(alive);
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

  if (i.toggleScoreboard) hud.toggleScoreboard();

  // Aim-down-sights: FOV and laser-sight track the controller's aim blend.
  const aimAmt = alive ? controller.aimBlend : 0;
  const baseFov = refs.getBaseFov();
  const adsFov = baseFov * 0.55;
  refs.camera.fov = baseFov + (adsFov - baseFov) * aimAmt;
  refs.camera.updateProjectionMatrix();
  localAvatar.setLaserVisible(aimAmt > 0.1);

  // Shooting (no firing while dead)
  if (alive && i.fireHeld && !reloading && magazine > 0 && performance.now() - lastShotAt > shotIntervalMs) {
    lastShotAt = performance.now();
    magazine -= 1;
    hud.setMagazine(magazine);
    // Bullet ray runs from the gun barrel to the convergent aim point, so
    // the visible tracer matches the laser direction exactly.
    const muzzle = controller.getMuzzlePosition();
    const bulletDir = aimTargetScratch.clone().sub(muzzle).normalize();
    const result = aim(muzzle, bulletDir, avatars);
    tracers.push(spawnTracer(refs.scene, refs.camera, muzzle, result.point));
    if (room && result.targetId) {
      room.send("shoot", { targetId: result.targetId });
    }
    if (magazine === 0) startReload();
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
  setTimeout(() => {
    magazine = magazineSize;
    reloading = false;
    hud.setMagazine(magazine);
  }, reloadDuration * 1000);
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
