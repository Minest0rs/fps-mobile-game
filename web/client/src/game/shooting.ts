import * as THREE from "three";
import { Avatar } from "./avatar";

export interface AimResult {
  targetId?: string;
  point: THREE.Vector3;
}

/** Given the camera and all remote avatars, raycast and return the first remote
 *  player hit (if any) along with the impact point. */
export function aim(
  camera: THREE.PerspectiveCamera,
  avatars: Map<string, Avatar>,
  range = 80,
): AimResult {
  const origin = camera.position.clone();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);

  const ray = new THREE.Raycaster(origin, dir, 0.1, range);
  const hitMeshes: { mesh: THREE.Object3D; id: string }[] = [];
  avatars.forEach((avatar, id) => {
    if (!avatar.group.visible) return;
    avatar.group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) hitMeshes.push({ mesh: child, id });
    });
  });

  const intersects = ray.intersectObjects(hitMeshes.map((h) => h.mesh), false);
  if (intersects.length === 0) {
    return { point: origin.clone().addScaledVector(dir, range) };
  }
  const first = intersects[0];
  const id = hitMeshes.find((h) => h.mesh === first.object)?.id;
  return { targetId: id, point: first.point };
}

/** Spawn a transient red tracer beam from `from` to `to`. */
export function spawnTracer(scene: THREE.Scene, from: THREE.Vector3, to: THREE.Vector3) {
  const geom = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.8 });
  const line = new THREE.Line(geom, mat);
  scene.add(line);
  let life = 0.08;
  const tick = (dt: number) => {
    life -= dt;
    mat.opacity = Math.max(0, life / 0.08) * 0.8;
    if (life <= 0) { scene.remove(line); geom.dispose(); mat.dispose(); return false; }
    return true;
  };
  return tick;
}
