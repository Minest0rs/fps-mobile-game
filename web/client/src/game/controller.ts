import * as THREE from "three";
import { InputManager } from "./input";
import type { Obstacles } from "./scene";

const GRAVITY = -22;
const JUMP_VELOCITY = 8.0;
const MOVE_SPEED = 6.0;
const PITCH_LIMIT = 1.4;
const PLAYER_RADIUS = 0.45;

/**
 * Owns the local player camera and emits movement updates. Movement is computed
 * client-side (predicted) and the server receives raw position; the server clamps
 * and reflects that position back through the replicated state.
 */
export class LocalController {
  // Starting position is offset from origin so that, even before the server
  // delivers a real spawn point, the camera isn't inside the center pillar.
  readonly position = new THREE.Vector3(8, 1.6, 8);
  yaw = 0;
  pitch = 0;
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
  }

  /** Runs every frame. Returns true if any state worth syncing changed. */
  update(dt: number, input: ReturnType<InputManager["consume"]>): boolean {
    this.yaw -= input.lookDelta.x;
    this.pitch -= input.lookDelta.y;
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

    this.position.y += dy;

    if (this.position.y <= 1.6) {
      this.position.y = 1.6;
      this.velocityY = 0;
      this.grounded = true;
    }

    const lim = this.arenaHalf - 0.6;
    if (this.position.x > lim) this.position.x = lim;
    if (this.position.x < -lim) this.position.x = -lim;
    if (this.position.z > lim) this.position.z = lim;
    if (this.position.z < -lim) this.position.z = -lim;

    this.camera.position.copy(this.position);
    const e = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(e);

    return true;
  }

  /** Push the player out of any horizontal obstacle they overlap. */
  private resolveHorizontal() {
    const r = PLAYER_RADIUS;
    // Boxes: clamp the player center to outside each box.
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
      // Push along the smaller axis.
      const px = b.min.x - r - 0.001 < this.position.x && this.position.x < b.max.x + r + 0.001;
      const pz = b.min.z - r - 0.001 < this.position.z && this.position.z < b.max.z + r + 0.001;
      if (!px && !pz) continue;
      const overlapX = Math.min(this.position.x - (b.min.x - r), (b.max.x + r) - this.position.x);
      const overlapZ = Math.min(this.position.z - (b.min.z - r), (b.max.z + r) - this.position.z);
      if (overlapX < overlapZ) {
        this.position.x = this.position.x < (b.min.x + b.max.x) / 2 ? b.min.x - r : b.max.x + r;
      } else {
        this.position.z = this.position.z < (b.min.z + b.max.z) / 2 ? b.min.z - r : b.max.z + r;
      }
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
