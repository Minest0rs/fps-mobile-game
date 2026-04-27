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
  private gun: THREE.Mesh;
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

    const gunMat = new THREE.MeshStandardMaterial({ color: 0x222a38, roughness: 0.6, metalness: 0.6 });
    this.gun = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.7), gunMat);
    this.gun.position.set(0.35, 1.45, 0.35);
    this.gun.castShadow = true;
    this.group.add(this.gun);

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
    this.gun.rotation.x = -pitch;
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
