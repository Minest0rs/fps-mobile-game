import * as THREE from "three";
import { SKINS } from "../profile";

/**
 * Visual representation of a remote player: a capsule body, a small head, and a
 * simple "weapon" wedge that tracks the player's yaw + pitch. Skin determines colour.
 */
export class Avatar {
  readonly group = new THREE.Group();
  private body: THREE.Mesh;
  private head: THREE.Mesh;
  /** Group that holds the gun's body, grip, magazine, sight, etc. so the
   *  whole assembly tilts together with pitch. */
  private gun: THREE.Group;
  private laser!: THREE.Line;
  private nameTag: THREE.Sprite;

  constructor(name: string, skinId: string) {
    const s = SKINS[skinId] ?? SKINS.neon;
    const mat = new THREE.MeshStandardMaterial({
      color: s.color, emissive: s.emissive, emissiveIntensity: 0.35,
      roughness: 0.5, metalness: 0.2,
    });

    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 6, 12), mat);
    this.body.position.y = 0.9;
    this.body.castShadow = true;
    this.group.add(this.body);

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), mat);
    this.head.position.y = 1.7;
    this.head.castShadow = true;
    this.group.add(this.head);

    // Gun assembly — multiple boxes giving a recognisable rifle silhouette
    // (handguard, barrel, stock, grip, magazine, top sight). The whole group
    // tilts together with pitch via setPose().
    this.gun = new THREE.Group();
    this.gun.position.set(0.35, 1.45, -0.30);
    const matBlack = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.55, metalness: 0.7 });
    const matGrip  = new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.85, metalness: 0.1 });
    const matBarrel = new THREE.MeshStandardMaterial({ color: 0x0f1014, roughness: 0.4,  metalness: 0.85 });
    // Receiver / handguard — main body; centred along forward (-Z).
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.16, 0.55), matBlack);
    receiver.position.set(0, 0, -0.20);
    // Stock — rear of the rifle, sits behind the receiver.
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.30), matBlack);
    stock.position.set(0, -0.02, 0.18);
    // Grip — angled box behind the magazine.
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.20, 0.10), matGrip);
    grip.position.set(0, -0.18, -0.02);
    grip.rotation.x = 0.18;
    // Magazine — drops below receiver just ahead of the grip.
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.20, 0.10), matBlack);
    mag.position.set(0, -0.18, -0.18);
    // Barrel — thinner cylinder extending forward from the receiver.
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.035, 0.55, 12), matBarrel);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.72);
    // Top rail / sight — small block on top giving a clear front profile.
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.42), matBlack);
    rail.position.set(0, 0.10, -0.22);
    const frontPost = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.06, 0.025), matBlack);
    frontPost.position.set(0, 0.16, -0.42);
    for (const m of [receiver, stock, grip, mag, barrel, rail, frontPost]) {
      m.castShadow = true;
      this.gun.add(m);
    }
    this.group.add(this.gun);

    // Laser sight: a thin red line emanating from the muzzle (barrel tip) so
    // the player has an unambiguous visual cue of where the shot will go.
    const laserMat = new THREE.LineBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.95, fog: false });
    const laserGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.02, -0.99),
      new THREE.Vector3(0, 0.02, -120),
    ]);
    this.laser = new THREE.Line(laserGeom, laserMat);
    this.laser.visible = false; // off until ADS is held (controlled per-frame)
    this.gun.add(this.laser);

    this.nameTag = makeNameSprite(name);
    this.nameTag.position.set(0, 2.25, 0);
    this.group.add(this.nameTag);
  }

  setName(name: string) {
    this.group.remove(this.nameTag);
    this.nameTag = makeNameSprite(name);
    this.nameTag.position.set(0, 2.25, 0);
    this.group.add(this.nameTag);
  }

  setSkin(skinId: string) {
    const s = SKINS[skinId] ?? SKINS.neon;
    const mat = this.body.material as THREE.MeshStandardMaterial;
    mat.color.setHex(s.color);
    mat.emissive.setHex(s.emissive);
  }

  setPose(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.group.position.set(x, y - 1.6, z); // body's feet
    this.group.rotation.y = yaw;
    // After applying group Y-rotation, a positive X-rotation tilts the gun's
    // local -Z forward toward +Y (i.e. up), which matches how `pitch > 0`
    // means "looking up" everywhere else in the controller.
    this.gun.rotation.set(pitch, 0, 0);
  }

  /** Aim the gun (and its laser) at a specific world point so the visual
   *  barrel direction converges with where the camera-centred crosshair is
   *  looking. Used for the local player only — remote avatars use the
   *  replicated yaw/pitch directly via setPose(). */
  setAimTarget(target: THREE.Vector3) {
    // Object3D.lookAt aligns the local -Z axis with the target. The gun's
    // local -Z is the barrel forward (matches the laser direction), so this
    // is exactly what we want. Parent transform (group rotation) is taken
    // into account, so we don't need to manually invert the player's yaw.
    this.group.updateMatrixWorld(true);
    this.gun.lookAt(target);
  }

  setLaserVisible(v: boolean) {
    this.laser.visible = v;
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }
}

function makeNameSprite(name: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, 0, 0, c.width, c.height, 12); ctx.fill();
  ctx.fillStyle = "#e6e9ef";
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(name, c.width / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const s = new THREE.Sprite(mat);
  s.scale.set(2, 0.5, 1);
  return s;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
