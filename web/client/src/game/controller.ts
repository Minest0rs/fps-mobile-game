import * as THREE from "three";
import { InputManager } from "./input";

const GRAVITY = -22;
const JUMP_VELOCITY = 8.0;
const MOVE_SPEED = 6.0;
const PITCH_LIMIT = 1.4;

/**
 * Owns the local player camera and emits movement updates. Movement is computed
 * client-side (predicted) and the server receives raw position; the server clamps
 * and reflects that position back through the replicated state.
 */
export class LocalController {
  readonly position = new THREE.Vector3(0, 1.6, 0);
  yaw = 0;
  pitch = 0;
  private velocityY = 0;
  private grounded = true;

  constructor(private camera: THREE.PerspectiveCamera, private arenaHalf: number) {}

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

    this.position.x += move.x;
    this.position.z += move.z;
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
}
