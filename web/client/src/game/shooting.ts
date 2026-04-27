import * as THREE from "three";
import { Avatar } from "./avatar";

export interface AimResult {
  targetId?: string;
  point: THREE.Vector3;
}

/** Given an aim ray (origin + direction) and all remote avatars, return the
 *  closest player hit (with generous aim assist) and the impact point along
 *  the shot.
 *
 *  We test a fat sphere around each avatar rather than the visible meshes so
 *  long-range shots that *look* on-target actually register. The sphere is
 *  much larger than the visible body — about player width — so the user
 *  doesn't have to be pixel-perfect at 30+ metres. */
export function aim(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  avatars: Map<string, Avatar>,
  range = 300,
): AimResult {

  // Scale hit radius with distance: at point-blank we keep it tight (~head/
  // shoulder size), but at long range we widen the volume substantially so a
  // small angular error still connects (touch aim on a phone is imprecise).
  const NEAR_R = 0.8;
  const FAR_R  = 3.2;
  const FAR_DIST = 20;

  let bestT = range;
  let bestId: string | undefined;
  const oc = new THREE.Vector3();
  avatars.forEach((avatar, id) => {
    if (!avatar.group.visible) return;
    // Capsule body centre is about (group.x, group.y + 1.0, group.z).
    const cx = avatar.group.position.x;
    const cy = avatar.group.position.y + 1.0;
    const cz = avatar.group.position.z;
    oc.set(origin.x - cx, origin.y - cy, origin.z - cz);
    const b = oc.dot(dir);
    if (b > 0) return; // target is behind the camera
    // Distance from the avatar centre to the closest point on the ray:
    const closest = oc.lengthSq() - b * b;
    const distAlong = -b;
    const t = Math.min(1, distAlong / FAR_DIST);
    const r = NEAR_R + (FAR_R - NEAR_R) * t;
    if (closest > r * r) return;
    // Solve for the entry point on the sphere (closer of the two roots).
    const half = Math.sqrt(r * r - closest);
    const enter = distAlong - half;
    if (enter < 0.1 || enter > bestT) return;
    bestT = enter;
    bestId = id;
  });

  const point = origin.clone().addScaledVector(dir, bestT);
  return bestId ? { targetId: bestId, point } : { point };
}

/** Spawn a transient bullet tracer from `from` toward `to`.
 *
 *  Visualised as:
 *    1. A bright muzzle flash sphere at the gun.
 *    2. A thin glowing camera-facing beam stretched along the shot path
 *       (a unit-length plane scaled to the shot length and oriented so
 *       it always faces the camera; this stays visible from any angle,
 *       unlike a cylinder/line which can degenerate).
 *    3. An orange impact spark at the hit point. */
export function spawnTracer(
  scene: THREE.Scene,
  camera: THREE.Camera,
  from: THREE.Vector3,
  to: THREE.Vector3,
  color = 0xfff1a5,
  width = 0.12,
) {
  const delta = new THREE.Vector3().subVectors(to, from);
  const length = delta.length();
  if (length < 0.5) return (_dt: number) => false;
  const dir = delta.clone().normalize();
  const mid = from.clone().addScaledVector(dir, length / 2);

  // Beam: a thin rectangle along the shot axis, oriented so its short
  // side points at the camera each frame (we orient once at spawn — for
  // the brief lifetime that's visually indistinguishable from continuous
  // billboarding and is much cheaper).
  const beamGeom = new THREE.PlaneGeometry(width, 1);
  // Orient: long axis (Y) along the shot, short axis (X) perpendicular to
  // both shot dir and the camera->shot vector — always pointing at the
  // camera as long as the shot is roughly perpendicular to that view.
  const camToMid = new THREE.Vector3().subVectors(mid, camera.position).normalize();
  const sideways = new THREE.Vector3().crossVectors(dir, camToMid).normalize();
  const facing = new THREE.Vector3().crossVectors(sideways, dir).normalize();
  const m4 = new THREE.Matrix4().makeBasis(sideways, dir, facing);
  const beamMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(beamGeom, beamMat);
  beam.position.copy(mid);
  beam.scale.set(1, length, 1);
  beam.quaternion.setFromRotationMatrix(m4);
  beam.renderOrder = 10;
  scene.add(beam);

  // Muzzle flash — large bright burst right at the barrel.
  const flashGeom = new THREE.SphereGeometry(0.35, 12, 10);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xfff5c0, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const flash = new THREE.Mesh(flashGeom, flashMat);
  flash.position.copy(from).addScaledVector(dir, 0.15);
  flash.renderOrder = 11;
  scene.add(flash);

  // Impact spark — orange-red burst at the hit point.
  const sparkGeom = new THREE.SphereGeometry(0.28, 12, 10);
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0xff8a3a, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const spark = new THREE.Mesh(sparkGeom, sparkMat);
  spark.position.copy(to);
  spark.renderOrder = 11;
  scene.add(spark);

  const FLASH_LIFE = 0.08;
  const BEAM_LIFE  = 0.18;
  const SPARK_LIFE = 0.25;
  let t = 0;
  return (dt: number) => {
    t += dt;
    flashMat.opacity = Math.max(0, 1 - t / FLASH_LIFE);
    beamMat.opacity  = Math.max(0, 0.95 * (1 - t / BEAM_LIFE));
    sparkMat.opacity = Math.max(0, 1 - t / SPARK_LIFE);
    // Spark grows slightly as it fades for a more impact-y feel.
    const k = 1 + Math.min(1, t / SPARK_LIFE) * 1.4;
    spark.scale.setScalar(k);
    if (t >= SPARK_LIFE && t >= BEAM_LIFE && t >= FLASH_LIFE) {
      for (const obj of [beam, flash, spark]) scene.remove(obj);
      beamGeom.dispose();  beamMat.dispose();
      flashGeom.dispose(); flashMat.dispose();
      sparkGeom.dispose(); sparkMat.dispose();
      return false;
    }
    return true;
  };
}
