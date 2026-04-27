import * as THREE from "three";
import { InputManager } from "./input";
import type { Obstacles } from "./scene";

const DEFAULT_GRAVITY = -22;
const JUMP_VELOCITY = 8.0;
const MOVE_SPEED = 6.0;
const PITCH_LIMIT = 1.1;
const PLAYER_RADIUS = 0.45;
/** Movement smoothing — players accelerate from zero and decelerate to
 *  zero over ~0.18 s instead of teleporting to full speed. Gives the
 *  character weight without making controls feel sluggish. */
const ACCEL_PER_SEC = 38; // m/s² (full-speed in ~0.16 s from rest)
const DECEL_PER_SEC = 30;
/** Underwater behaviour: lowered movement, gravity, and oxygen drain. */
const UNDERWATER_SPEED_MULT = 0.55;
const UNDERWATER_GRAVITY_MULT = 0.35;
/** Water surface y (must match scene.ts water plane). */
const WATER_Y = -0.4;
/** Total oxygen capacity (seconds of submerged time). */
const OXYGEN_MAX = 12;
/** Damage per second while oxygen is empty and head still underwater. */
const DROWN_DPS = 8;
// Third-person camera offsets. ADS arcs the camera over the right shoulder
// rather than pulling it straight in toward the player's back: that keeps
// the centre of the screen clear of the avatar's body so the crosshair is
// always readable. The "side bulge" peaks mid-transition for a curved feel.
const CAM_DIST_HIP = 4.2;
const CAM_DIST_ADS = 2.4;
const CAM_HEIGHT_HIP = 0.0;
const CAM_HEIGHT_ADS = 0.35;
const SHOULDER_HIP = 0.45;
const SHOULDER_ADS = 0.85;
/** Extra lateral arc that peaks at aimBlend = 0.5; keeps the path curved. */
const SHOULDER_ARC = 0.30;

/**
 * Owns the local player camera and emits movement updates. Movement is computed
 * client-side (predicted) and the server receives raw position; the server clamps
 * and reflects that position back through the replicated state.
 */
export class LocalController {
  // Starting position is offset from origin so that, even before the server
  // delivers a real spawn point, the camera isn't inside the center pillar.
  readonly position = new THREE.Vector3(8, 1.6, 8);
  // Initial yaw faces toward the arena origin (so the spawn view is the centre
  // pillar rather than an empty wall).
  yaw = Math.PI / 4;
  pitch = 0;
  /** Blend toward 1 while ADS is held; smoothed in update(). */
  aimBlend = 0;
  /** Mutable gravity so match-events (low gravity) can swap it at runtime. */
  gravity = DEFAULT_GRAVITY;
  /** Accumulated recoil that bleeds back toward zero each frame. The
   *  effective camera pitch/yaw shown to the player is `pitch + recoilPitch`
   *  / `yaw + recoilYaw`, so a shot kicks the view up and slightly left or
   *  right, then drifts back. The user's input directly modifies pitch/yaw,
   *  so dragging down while firing fights the kick the way it does in real
   *  shooters. */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private velocityY = 0;
  private grounded = true;
  /** Smoothed horizontal velocity (m/s in world space). Eased toward
   *  the input-derived target velocity for accel/decel feel. */
  private velX = 0;
  private velZ = 0;
  /** Walk distance accumulator drives the head-bob sinusoid. Reset when
   *  the player stops or leaves the ground. */
  private bobPhase = 0;
  /** Oxygen state. Underwater the timer drains; above water it regens
   *  toward OXYGEN_MAX. Drowning damage accumulates while oxygen == 0
   *  and the head is still submerged. Read by HUD + main loop. */
  oxygen = OXYGEN_MAX;
  isUnderwater = false;
  /** Hp damage to be applied externally (main loop reads + clears each
   *  frame, then forwards to the room as a self-damage message). */
  pendingDrownDamage = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private arenaHalf: number,
    private obstacles: Obstacles = { boxes: [], cylinders: [] },
    /** Ground elevation lookup; defaults to flat 0 when not provided. */
    private heightAt: (x: number, z: number) => number = () => 0,
  ) {}

  setPosition(x: number, y: number, z: number) {
    this.position.set(x, y, z);
    this.velocityY = 0;
    this.grounded = true;
    // Face the arena centre so the player sees the action immediately after
    // spawn rather than staring at the wall they happened to be next to.
    const dx = -x;
    const dz = -z;
    if (dx * dx + dz * dz > 0.01) {
      this.yaw = Math.atan2(-dx, -dz);
      this.pitch = 0;
    }
  }

  /** Inject a recoil impulse from a fired weapon. Strength comes from
   *  `WeaponDef.recoil` (radians) — a sniper kicks the view up several
   *  degrees, an SMG barely a fraction of one. Yaw kick is a small random
   *  fraction of the strength so spray patterns wobble side-to-side. */
  applyRecoil(strength: number) {
    // ADS reduces felt recoil (you're bracing the gun against your
    // shoulder), matching the behaviour of every modern shooter.
    const factor = 1 - 0.4 * this.aimBlend;
    this.recoilPitch += strength * factor;
    this.recoilYaw += (Math.random() - 0.5) * strength * 0.5 * factor;
  }

  /** Runs every frame. Returns true if any state worth syncing changed. */
  update(dt: number, input: ReturnType<InputManager["consume"]>): boolean {
    // Smoothly blend the ADS amount so camera transitions are not jarring.
    const aimTarget = input.aimHeld ? 1 : 0;
    this.aimBlend += (aimTarget - this.aimBlend) * Math.min(1, dt * 12);
    // While aiming, halve look sensitivity so precision is easier on touch.
    const lookScale = 1 - 0.55 * this.aimBlend;
    this.yaw -= input.lookDelta.x * lookScale;
    this.pitch -= input.lookDelta.y * lookScale;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;

    // Recoil bleeds back to zero with an ~180 ms time constant. The user's
    // own pull-down input above is independent — they can choose to fight
    // the kick or let it ride.
    const recoilDecay = Math.pow(0.0015, dt);
    this.recoilPitch *= recoilDecay;
    this.recoilYaw *= recoilDecay;

    // Underwater check — head is at (position.y) which is eye height
    // (1.6 m above feet). When the eye drops below the water surface,
    // movement slows, gravity is reduced, and oxygen drains.
    this.isUnderwater = this.position.y < WATER_Y;
    const speedMult = this.isUnderwater ? UNDERWATER_SPEED_MULT : 1;

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right   = new THREE.Vector3(Math.cos(this.yaw),  0, -Math.sin(this.yaw));
    const inputDir = new THREE.Vector3()
      .addScaledVector(forward, input.move.y)
      .addScaledVector(right, input.move.x);
    if (inputDir.lengthSq() > 1) inputDir.normalize();
    const targetVx = inputDir.x * MOVE_SPEED * speedMult;
    const targetVz = inputDir.z * MOVE_SPEED * speedMult;

    // Smooth velocity toward the target — accelerate when the player is
    // pushing in a direction, decelerate to zero on release. This makes
    // strafing feel weighted instead of teleport-snappy.
    const accel = inputDir.lengthSq() > 0.01 ? ACCEL_PER_SEC : DECEL_PER_SEC;
    const ax = targetVx - this.velX;
    const az = targetVz - this.velZ;
    const aMag = Math.hypot(ax, az);
    if (aMag > 1e-6) {
      const k = Math.min(1, (accel * dt) / aMag);
      this.velX += ax * k;
      this.velZ += az * k;
    }
    const move = new THREE.Vector3(this.velX * dt, 0, this.velZ * dt);

    if (input.jumpRequested && this.grounded && !this.isUnderwater) {
      this.velocityY = JUMP_VELOCITY;
      this.grounded = false;
    }

    const grav = this.gravity * (this.isUnderwater ? UNDERWATER_GRAVITY_MULT : 1);
    this.velocityY += grav * dt;
    const dy = this.velocityY * dt;

    // Move on each horizontal axis separately so the player slides along
    // walls instead of sticking to them. Reject any axis-step that would
    // require climbing terrain steeper than ~45° relative to the current
    // foot height — without this, the heightfield-driven cliff ring at
    // the boundary acts as a ramp, letting players walk straight up the
    // outer wall.
    const MAX_STEP_RISE = 1.2; // metres of climb permitted per metre of horizontal motion
    const groundNow = this.heightAt(this.position.x, this.position.z);
    const tryX = this.position.x + move.x;
    const groundAfterX = this.heightAt(tryX, this.position.z);
    if (groundAfterX - groundNow < Math.abs(move.x) * MAX_STEP_RISE + 0.01) {
      this.position.x = tryX;
      this.resolveHorizontal();
    } else {
      this.velX = 0; // hit a too-steep slope, drop X velocity
    }
    const groundMid = this.heightAt(this.position.x, this.position.z);
    const tryZ = this.position.z + move.z;
    const groundAfterZ = this.heightAt(this.position.x, tryZ);
    if (groundAfterZ - groundMid < Math.abs(move.z) * MAX_STEP_RISE + 0.01) {
      this.position.z = tryZ;
      this.resolveHorizontal();
    } else {
      this.velZ = 0;
    }

    const oldFeet = this.position.y - 1.6;
    this.position.y += dy;
    this.resolveVertical(oldFeet);

    const lim = this.arenaHalf - 0.6;
    if (this.position.x > lim) this.position.x = lim;
    if (this.position.x < -lim) this.position.x = -lim;
    if (this.position.z > lim) this.position.z = lim;
    if (this.position.z < -lim) this.position.z = -lim;

    // Third-person camera: arcs over the right shoulder during ADS instead
    // of pulling straight in toward the player's back. The path is curved
    // (extra lateral bulge mid-transition) so the camera "rolls" sideways
    // around the player rather than crashing into the body — that keeps
    // the avatar out of the centre of the screen and the crosshair clear.
    const t = this.aimBlend;
    // Ease-out cubic — ADS feels snappy at the start, settles at the end.
    const ease = 1 - (1 - t) * (1 - t) * (1 - t);
    const camDist  = CAM_DIST_HIP   + (CAM_DIST_ADS   - CAM_DIST_HIP)   * ease;
    const baseShoulder = SHOULDER_HIP + (SHOULDER_ADS - SHOULDER_HIP) * ease;
    const arcBulge = SHOULDER_ARC * Math.sin(Math.PI * t);
    const shoulder = baseShoulder + arcBulge;
    const heightOffset = CAM_HEIGHT_HIP + (CAM_HEIGHT_ADS - CAM_HEIGHT_HIP) * ease;
    // Effective view angles include the recoil offset so the gun's kick
    // is visible to the player.
    const effPitch = THREE.MathUtils.clamp(this.pitch + this.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);
    const effYaw = this.yaw + this.recoilYaw;
    const cosP = Math.cos(effPitch);
    const sinP = Math.sin(effPitch);
    // Shift both camera origin and the look-at target laterally by the same
    // amount; that keeps the camera ray parallel to the no-shift case so the
    // crosshair still maps cleanly to a world ray.
    const rx = Math.cos(effYaw);
    const rz = -Math.sin(effYaw);
    const cx = this.position.x + camDist * Math.sin(effYaw) * cosP + shoulder * rx;
    const cz = this.position.z + camDist * Math.cos(effYaw) * cosP + shoulder * rz;
    // Don't let the camera duck beneath the terrain at its own (x, z).
    // Using a fixed lower bound (e.g. 0.6) breaks pitch when the player is
    // standing in a depression below y = 0 — like the river — because the
    // camera would clamp above the player's head and pitch input wouldn't
    // move the view at all.
    const camGround = this.heightAt(cx, cz);
    const cy = Math.max(
      camGround + 0.4,
      this.position.y + heightOffset - camDist * sinP,
    );
    // Head bob — only when moving on the ground. Adds a tiny vertical
    // sinusoid to the camera and look-at target so the world subtly
    // bounces in time with footsteps. Disabled while ADS so the
    // crosshair stays stable when aiming.
    const horizSpeed = Math.hypot(this.velX, this.velZ);
    if (this.grounded && horizSpeed > 0.5 && this.aimBlend < 0.5) {
      this.bobPhase += dt * (6 + horizSpeed * 0.3);
    } else {
      this.bobPhase *= Math.pow(0.001, dt); // ease back to 0 quickly
    }
    const bobAmt = Math.min(1, horizSpeed / MOVE_SPEED) * (1 - this.aimBlend);
    const bobY = Math.sin(this.bobPhase * 2) * 0.045 * bobAmt;
    const bobX = Math.cos(this.bobPhase) * 0.025 * bobAmt;

    this.camera.position.set(cx, cy + bobY, cz);
    this.camera.lookAt(
      this.position.x + shoulder * rx + bobX * rx,
      this.position.y + heightOffset + bobY,
      this.position.z + shoulder * rz + bobX * rz,
    );

    // Oxygen + drown logic. Submerged head depletes oxygen; surfacing
    // regenerates it (faster than depletion so resurfacing recovers).
    // When oxygen hits 0 and the head stays submerged, accumulate
    // damage that the main loop reads + sends to the room.
    if (this.isUnderwater) {
      this.oxygen = Math.max(0, this.oxygen - dt);
      if (this.oxygen <= 0) this.pendingDrownDamage += DROWN_DPS * dt;
    } else {
      this.oxygen = Math.min(OXYGEN_MAX, this.oxygen + dt * 2);
    }

    return true;
  }

  /** Read + clear the accumulated drown damage. Returns whole HP units
   *  (the main loop sends one self-damage message per integer). */
  consumeDrownDamage(): number {
    if (this.pendingDrownDamage < 1) return 0;
    const whole = Math.floor(this.pendingDrownDamage);
    this.pendingDrownDamage -= whole;
    return whole;
  }

  /** Oxygen as a 0..1 fraction for HUD bars. */
  oxygenFraction(): number {
    return this.oxygen / OXYGEN_MAX;
  }

  /** World-space position of the avatar's gun barrel, used as the spawn point
   *  for tracers so they appear to come from the gun rather than from inside
   *  the body or from the third-person camera. */
  getMuzzlePosition(): THREE.Vector3 {
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // Matches the rifle assembly in avatar.ts: gun group at local
    // (0.35, 1.45, -0.30), barrel tip at gun-local z = -0.995.
    const lx = 0.35;
    const lz = -1.30;
    const wx = this.position.x + lx * cy + lz * sy;
    const wz = this.position.z - lx * sy + lz * cy;
    return new THREE.Vector3(wx, this.position.y - 0.15, wz);
  }

  /** Land on top of crates and stop against ceilings; clamps to terrain last.
   *  Player is treated as a capsule from feet (position.y - 1.6) to head
   *  (position.y + 0.4). The "swept" landing test catches the case where a
   *  fast descent skips the box top in one frame: if old feet were above the
   *  top and new feet are below it, snap onto the top regardless of how
   *  deep we plunged. */
  private resolveVertical(oldFeet: number) {
    const r = PLAYER_RADIUS;
    if (this.velocityY <= 0) {
      let bestTop = -Infinity;
      for (const b of this.obstacles.boxes) {
        const inX = this.position.x > b.min.x - r && this.position.x < b.max.x + r;
        const inZ = this.position.z > b.min.z - r && this.position.z < b.max.z + r;
        if (!inX || !inZ) continue;
        const newFeet = this.position.y - 1.6;
        // Two ways to land on this box: (1) we were standing on or above
        // its top last frame and crossed down through it (the classic swept
        // case), (2) we are currently inside the top half-metre slab of the
        // box (a small grace zone — fixes "sinking" when arriving at the
        // top with a tiny vertical penetration after horizontal slide).
        const swept = oldFeet >= b.max.y - 0.02 && newFeet < b.max.y;
        const insideTopSlab = newFeet > b.max.y - 0.5 && newFeet < b.max.y && this.velocityY <= 0;
        if ((swept || insideTopSlab) && b.max.y > bestTop) bestTop = b.max.y;
      }
      if (bestTop > -Infinity) {
        this.position.y = bestTop + 1.6;
        this.velocityY = 0;
        this.grounded = true;
      }
    } else {
      // Rising: bonk head on the underside of any box above us.
      const oldHead = oldFeet + 2.0;
      const newHead = this.position.y + 0.4;
      for (const b of this.obstacles.boxes) {
        const inX = this.position.x > b.min.x - r && this.position.x < b.max.x + r;
        const inZ = this.position.z > b.min.z - r && this.position.z < b.max.z + r;
        if (!inX || !inZ) continue;
        if (oldHead <= b.min.y && newHead > b.min.y) {
          this.position.y = b.min.y - 0.4 - 0.01;
          this.velocityY = 0;
        }
      }
    }
    // Terrain floor — sample the heightfield at our (x, z) and clamp feet.
    const ground = this.heightAt(this.position.x, this.position.z);
    if (this.position.y <= ground + 1.6) {
      this.position.y = ground + 1.6;
      this.velocityY = 0;
      this.grounded = true;
    }
  }

  /** Push the player out of any horizontal obstacle they overlap. Iterates a
   *  few times so corners between two adjacent boxes resolve cleanly. */
  private resolveHorizontal() {
    const r = PLAYER_RADIUS;
    const feet = this.position.y - 1.6;
    const head = this.position.y + 0.4;
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const b of this.obstacles.boxes) {
        // Player capsule must overlap the box vertically for a horizontal
        // push-out to apply. Using feet/head (NOT eye±r) is critical: with
        // eye-relative checks, jumping NEXT to a tall crate would let the
        // player's body slip through the crate's side because the eye is
        // above the crate top while the feet are still inside the crate's
        // vertical extent.
        if (feet > b.max.y - 0.02) continue;
        if (head < b.min.y + 0.02) continue;
        const cx = Math.max(b.min.x, Math.min(this.position.x, b.max.x));
        const cz = Math.max(b.min.z, Math.min(this.position.z, b.max.z));
        const dx = this.position.x - cx;
        const dz = this.position.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-6) {
          // Player center is outside the box, just inside its rounded
          // corner skin: push radially out along the closest-point vector.
          // This produces clean corner sliding without a "snap".
          const d = Math.sqrt(d2);
          this.position.x = cx + (dx / d) * (r + 1e-3);
          this.position.z = cz + (dz / d) * (r + 1e-3);
        } else {
          // Player center is inside the box (rare, e.g. spawned overlapping):
          // pop out along whichever axis has the least overlap.
          const overlapX = Math.min(this.position.x - b.min.x, b.max.x - this.position.x);
          const overlapZ = Math.min(this.position.z - b.min.z, b.max.z - this.position.z);
          if (overlapX < overlapZ) {
            this.position.x = this.position.x < (b.min.x + b.max.x) / 2 ? b.min.x - r : b.max.x + r;
          } else {
            this.position.z = this.position.z < (b.min.z + b.max.z) / 2 ? b.min.z - r : b.max.z + r;
          }
        }
        moved = true;
      }
      if (!moved) break;
    }
    // Cylinders: push out radially.
    for (const c of this.obstacles.cylinders) {
      const dx = this.position.x - c.x;
      const dz = this.position.z - c.z;
      const dist = Math.hypot(dx, dz);
      const min = c.r + r;
      if (dist >= min) continue;
      if (dist < 1e-4) {
        this.position.x = c.x + min;
      } else {
        const k = min / dist;
        this.position.x = c.x + dx * k;
        this.position.z = c.z + dz * k;
      }
    }
  }
}
