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
  lookArea: document.getElementById("look-area")!,
  fireButton: document.getElementById("fire-button")!,
  jumpButton: document.getElementById("jump-button")!,
  scoreboardButton: document.getElementById("scoreboard-button")!,
});

const magazineSize = 30;
let magazine = magazineSize;
let reloading = false;
const reloadDuration = 1.6;

const hud = new Hud();
hud.setMagazine(magazine);

const controller = new LocalController(refs.camera, refs.arenaHalf, refs.obstacles);

// Local player avatar — visible to the local player in third-person view.
// Kept out of `avatars` so it isn't tested as a hit target.
const localAvatar = new Avatar("You", load().skin);
localAvatar.setVisible(true);
refs.scene.add(localAvatar.group);

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
    const av = new Avatar(p.name, p.skin);
    av.setPose(p.x, p.y, p.z, p.yaw, p.pitch);
    av.setVisible(p.hp > 0);
    refs.scene.add(av.group);
    avatars.set(id, av);
    // Schema 2.x style: onChange is a method that returns an unsubscribe fn.
    const sync = () => {
      av.setPose(p.x, p.y, p.z, p.yaw, p.pitch);
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

  if (i.toggleScoreboard) hud.toggleScoreboard();

  // Shooting (no firing while dead)
  if (alive && i.fireHeld && !reloading && magazine > 0 && performance.now() - lastShotAt > shotIntervalMs) {
    lastShotAt = performance.now();
    magazine -= 1;
    hud.setMagazine(magazine);
    const result = aim(refs.camera, avatars);
    tracers.push(spawnTracer(refs.scene, refs.camera, controller.getMuzzlePosition(), result.point));
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
