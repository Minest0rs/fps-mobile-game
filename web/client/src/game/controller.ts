import * as THREE from "three";
import { InputManager } from "./input";
import type { Obstacles } from "./scene";

const GRAVITY = -22;
const JUMP_VELOCITY = 8.0;
const MOVE_SPEED = 6.0;
const PITCH_LIMIT = 1.1;
const PLAYER_RADIUS = 0.45;
// Third-person camera offsets — the hipfire pose is "over the shoulder",
// the ADS pose is closer and tighter behind the head.
const CAM_DIST_HIP = 4.5;
const CAM_DIST_ADS = 2.2;
const SHOULDER_HIP = 0.9;
const SHOULDER_ADS = 0.45;

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
  private velocityY = 0;
  private grounded = true;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private arenaHalf: number,
    private obstacles: Obstacles = { boxes: [], cylinders: [] },
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

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right   = new THREE.Vector3(Math.cos(this.yaw),  0, -Math.sin(this.yaw));
    const move = new THREE.Vector3()
      .addScaledVector(forward, input.move.y)
      .addScaledVector(right, input.move.x);
    if (move.lengthSq() > 1) move.normalize();
    move.multiplyScalar(MOVE_SPEED * dt);

    if (input.jumpRequested && this.grounded) {
      this.velocityY = JUMP_VELOCITY;
      this.grounded = false;
    }

    this.velocityY += GRAVITY * dt;
    const dy = this.velocityY * dt;

    // Move on each horizontal axis separately so the player slides along
    // walls instead of sticking to them.
    this.position.x += move.x;
    this.resolveHorizontal();
    this.position.z += move.z;
    this.resolveHorizontal();

    const oldFeet = this.position.y - 1.6;
    this.position.y += dy;
    this.resolveVertical(oldFeet);

    const lim = this.arenaHalf - 0.6;
    if (this.position.x > lim) this.position.x = lim;
    if (this.position.x < -lim) this.position.x = -lim;
    if (this.position.z > lim) this.position.z = lim;
    if (this.position.z < -lim) this.position.z = -lim;

    // Third-person camera: orbit behind the player and shifted to the right
    // for an over-the-shoulder feel. Both pose distance and shoulder offset
    // tighten while aiming, so ADS feels like leaning into the sights.
    const camDist = CAM_DIST_HIP + (CAM_DIST_ADS - CAM_DIST_HIP) * this.aimBlend;
    const shoulder = SHOULDER_HIP + (SHOULDER_ADS - SHOULDER_HIP) * this.aimBlend;
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    // Shift both camera origin and the look-at target laterally by the same
    // amount; that keeps the camera ray parallel to the no-shift case so the
    // crosshair still maps cleanly to a world ray.
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    const cx = this.position.x + camDist * Math.sin(this.yaw) * cosP + shoulder * rx;
    // Don't let an aggressive look-up push the camera through the floor.
    const cy = Math.max(0.6, this.position.y - camDist * sinP);
    const cz = this.position.z + camDist * Math.cos(this.yaw) * cosP + shoulder * rz;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(
      this.position.x + shoulder * rx,
      this.position.y,
      this.position.z + shoulder * rz,
    );

    return true;
  }

  /** World-space position of the avatar's gun barrel, used as the spawn point
   *  for tracers so they appear to come from the gun rather than from inside
   *  the body or from the third-person camera. */
  getMuzzlePosition(): THREE.Vector3 {
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // Local muzzle: in front of the right shoulder of the avatar
    // (gun model is at (0.35, 1.45, -0.55) with length 0.85, so the barrel
    // tip sits at z ≈ -0.98; round to -1.05 for headroom).
    const lx = 0.35;
    const lz = -1.05;
    const wx = this.position.x + lx * cy + lz * sy;
    const wz = this.position.z - lx * sy + lz * cy;
    return new THREE.Vector3(wx, this.position.y - 0.2, wz);
  }

  /** Land on top of crates and stop against ceilings; clamps to ground last. */
  private resolveVertical(oldFeet: number) {
    const r = PLAYER_RADIUS;
    if (this.velocityY <= 0) {
      // Falling: land on the highest crate top whose footprint we're over
      // and that we crossed downward through this frame.
      let bestTop = -Infinity;
      for (const b of this.obstacles.boxes) {
        const inX = this.position.x > b.min.x - r && this.position.x < b.max.x + r;
        const inZ = this.position.z > b.min.z - r && this.position.z < b.max.z + r;
        if (!inX || !inZ) continue;
        const newFeet = this.position.y - 1.6;
        if (oldFeet >= b.max.y - 0.05 && newFeet < b.max.y && b.max.y > bestTop) {
          bestTop = b.max.y;
        }
      }
      if (bestTop > -Infinity) {
        this.position.y = bestTop + 1.6;
        this.velocityY = 0;
        this.grounded = true;
      }
    } else {
      // Rising: bonk head on the underside of any box above us.
      const newHead = this.position.y;
      for (const b of this.obstacles.boxes) {
        const inX = this.position.x > b.min.x - r && this.position.x < b.max.x + r;
        const inZ = this.position.z > b.min.z - r && this.position.z < b.max.z + r;
        if (!inX || !inZ) continue;
        if (oldFeet + 1.6 <= b.min.y && newHead > b.min.y) {
          this.position.y = b.min.y - 0.01;
          this.velocityY = 0;
        }
      }
    }
    if (this.position.y <= 1.6) {
      this.position.y = 1.6;
      this.velocityY = 0;
      this.grounded = true;
    }
  }

  /** Push the player out of any horizontal obstacle they overlap. Iterates a
   *  few times so corners between two adjacent boxes resolve cleanly. */
  private resolveHorizontal() {
    const r = PLAYER_RADIUS;
    for (let iter = 0; iter < 4; iter++) {
      let moved = false;
      for (const b of this.obstacles.boxes) {
        // Skip boxes the player is fully above/below — used by floors only.
        if (this.position.y - r > b.max.y) continue;
        if (this.position.y + 2.0 < b.min.y) continue;
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
