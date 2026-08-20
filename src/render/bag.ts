/**
 * C · BagLayer (F-04) — 3D 가방 프리뷰
 * 스켈레톤 `initBag()` 이식. '패턴 → UV 텍스처 스왑' 파이프라인 증명용.
 *
 * ⚠️ 프록시 지오메트리(박스+토러스)는 자리 표시자.
 *    실제 가방 GLTF(`public/assets/`) 소싱·교체가 C 담당의 W1 과제. (DEV_SETUP §2)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { PatternTile } from '../contracts.ts';

export class BagLayer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly bag: THREE.Group;
  private bagMeshes: THREE.Mesh[] = [];
  private pendingTile: PatternTile | null = null;
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
    
    this.bag = new THREE.Group();
this.scene.add(this.bag);
const loader = new GLTFLoader();
loader.load(
  '/assets/bag.glb',
  (gltf) => {
  const model = gltf.scene;

  model.scale.set(1, 1, 1);
  model.position.set(0, 0.7, 0);

  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      this.bagMeshes.push(child);
      console.log('가방 Mesh 발견:', child.name, child.material);
    }
  });

  this.bag.add(model);

  if (this.pendingTile) {
  this.applyTile(this.pendingTile);
}

  console.log('가방 GLB 로드 성공!', model);
},
  undefined,
  (error) => {
  console.error('가방 GLB 로드 실패:', error);

  this.addFallbackBag();

  if (this.pendingTile) {
    this.applyTile(this.pendingTile);
  }
},
);

    this.loop();
  }

  /** PatternTile 을 가방 텍스처로 스왑. L2 승격 시에도 이 함수를 다시 부른다. */
  applyTile(tile: PatternTile): void {
  if (this.bagMeshes.length === 0) {
    this.pendingTile = tile;
    return;
  }

  this.pendingTile = null;

  const next = new THREE.Texture(tile.bitmap);
    next.colorSpace = THREE.SRGBColorSpace;
    next.wrapS = next.wrapT = THREE.RepeatWrapping;
    next.repeat.set(2, 2);
    next.needsUpdate = true;

    this.texture?.dispose();
this.texture = next;

this.bagMeshes.forEach((mesh) => {
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];

  materials.forEach((material) => {
    if (material instanceof THREE.MeshStandardMaterial) {
      material.map = next;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    }
  });
});
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

  private addFallbackBag(): void {
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xa9652c,
    roughness: 0.55,
    metalness: 0.08,
  });

  const darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a1c10,
    roughness: 0.5,
  });

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 1.25, 0.62),
    bodyMaterial,
  );

  const flap = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.5, 0.66),
    bodyMaterial,
  );
  flap.position.set(0, 0.42, 0.01);

  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.05, 12, 40, Math.PI),
    darkMaterial,
  );
  handle.position.y = 0.66;

  this.bag.add(body, flap, handle);
  this.bagMeshes.push(body, flap);
}

  private loop = (): void => {
    this.bag.rotation.y += 0.012;
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  };
}
