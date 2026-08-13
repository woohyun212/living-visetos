/**
 * C · BagLayer (F-04) — 3D 가방 프리뷰
 * 스켈레톤 `initBag()` 이식. '패턴 → UV 텍스처 스왑' 파이프라인 증명용.
 *
 * ⚠️ 프록시 지오메트리(박스+토러스)는 자리 표시자.
 *    실제 가방 GLTF(`public/assets/`) 소싱·교체가 C 담당의 W1 과제. (DEV_SETUP §2)
 */
import * as THREE from 'three';
import type { PatternTile } from '../contracts.ts';

export class BagLayer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly bag: THREE.Group;
  private texture: THREE.Texture | null = null;
  private frame = 0;

  constructor(private readonly wrap: HTMLElement) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    this.camera.position.set(0, 0.6, 4.2);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const size = wrap.clientWidth || 360;
    this.renderer.setSize(size, size);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    wrap.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const key = new THREE.DirectionalLight(0xfff2dd, 1.6);
    key.position.set(2, 3, 4);
    this.scene.add(key);

    this.material = new THREE.MeshStandardMaterial({
      color: 0xa9652c,
      roughness: 0.55,
      metalness: 0.08,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a1c10, roughness: 0.5 });

    this.bag = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.25, 0.62, 4, 4, 2), this.material);
    this.bag.add(body);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 0.66), this.material);
    flap.position.set(0, 0.42, 0.01);
    this.bag.add(flap);
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.05, 12, 40, Math.PI),
      dark,
    );
    handle.position.y = 0.66;
    this.bag.add(handle);
    this.scene.add(this.bag);

    this.loop();
  }

  /** PatternTile 을 가방 텍스처로 스왑. L2 승격 시에도 이 함수를 다시 부른다. */
  applyTile(tile: PatternTile): void {
    const next = new THREE.Texture(tile.bitmap);
    next.colorSpace = THREE.SRGBColorSpace;
    next.wrapS = next.wrapT = THREE.RepeatWrapping;
    next.repeat.set(2, 2);
    next.needsUpdate = true;

    this.texture?.dispose();
    this.texture = next;
    this.material.map = next;
    this.material.color.set(0xffffff);
    this.material.needsUpdate = true;
  }

  resize(): void {
    const size = this.wrap.clientWidth || 360;
    this.renderer.setSize(size, size);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.texture?.dispose();
    this.renderer.dispose();
  }

  private loop = (): void => {
    this.bag.rotation.y += 0.012;
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  };
}
