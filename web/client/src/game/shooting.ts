import * as THREE from "three";
import { Avatar } from "./avatar";

export interface AimResult {
  targetId?: string;
  point: THREE.Vector3;
}

/** Given the camera and all remote avatars, return the closest player hit
 *  (with generous aim assist) and the impact point along the shot.
 *
 *  We test a fat sphere around each avatar rather than the visible meshes so
 *  long-range shots that *look* on-target actually register. The sphere is
 *  much larger than the visible body — about player width — so the user
 *  doesn't have to be pixel-perfect at 30+ metres. */
export function aim(
  camera: THREE.PerspectiveCamera,
  avatars: Map<string, Avatar>,
  range = 200,
): AimResult {
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  // Scale hit radius with distance: at point-blank we keep it tight (~head/
  // shoulder size), but at long range we widen the volume so a small angular
  // error still connects.
  const NEAR_R = 0.55;
  const FAR_R  = 1.15;
  const FAR_DIST = 30;

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

/** Spawn a transient glowing tracer from `from` toward `to`.
 *
 *  Render the shot as a chain of glowing additive spheres rather than a
 *  beam: cylinders/planes degenerate to invisibly thin shapes when the
 *  camera looks along the shot axis (which is the common case in an FPS).
 *  A row of point-shaped sprites is unambiguous from any angle. */
export function spawnTracer(
  scene: THREE.Scene,
  _camera: THREE.Camera,
  from: THREE.Vector3,
  to: THREE.Vector3,
) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const totalLen = dir.length();
  if (totalLen < 0.5) return (_dt: number) => false;
  dir.normalize();

  const START_OFFSET = 0.6;
  const endLen = Math.max(0.6, totalLen - START_OFFSET);

  // Distribute pellets along the shot path; spacing scales with length so
  // long shots don't get crowded with hundreds of spheres.
  const SPACING = 1.2;
  const COUNT = Math.min(28, Math.max(4, Math.floor(endLen / SPACING)));
  const meshes: Array<{ mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; geom: THREE.BufferGeometry }> = [];

  // Muzzle flash (largest, brightest)
  meshes.push(makePellet(scene, from.clone().addScaledVector(dir, START_OFFSET), 0.45, 0xfff7c2));

  // Trail pellets — scale up with distance from camera so distant pellets
  // remain visible at all.
  for (let i = 1; i < COUNT - 1; i++) {
    const t = i / (COUNT - 1);
    const pos = from.clone().addScaledVector(dir, START_OFFSET + t * endLen);
    const distFromCamera = pos.distanceTo(from);
    const radius = 0.22 + Math.min(0.45, distFromCamera * 0.04);
    meshes.push(makePellet(scene, pos, radius, 0xffe066));
  }

  // Impact sphere
  meshes.push(makePellet(scene, to.clone(), 0.45, 0xff8a3a));

  const TOTAL_LIFE = 0.28;
  let life = TOTAL_LIFE;
  return (dt: number) => {
    life -= dt;
    const t = Math.max(0, life / TOTAL_LIFE);
    for (const m of meshes) m.mat.opacity = t;
    if (life <= 0) {
      for (const m of meshes) {
        scene.remove(m.mesh);
        m.geom.dispose();
        m.mat.dispose();
      }
      return false;
    }
    return true;
  };
}

function makePellet(scene: THREE.Scene, pos: THREE.Vector3, radius: number, color: number) {
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 1.0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const geom = new THREE.SphereGeometry(radius, 8, 6);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(pos);
  scene.add(mesh);
  return { mesh, mat, geom };
}
