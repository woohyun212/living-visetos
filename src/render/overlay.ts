/**
 * C · OverlayLayer (F-03) — 실루엣 오버레이
 * 스켈레톤 `segLoop()` 이식. 마스크 안쪽에만 타일을 합성한다.
 *
 * ⚠️ ADR-004: 여기 2D 캔버스 합성은 v0 검증용. three.js 단일 씬의 **셰이더 플레인**으로
 *    승격하는 것이 C 담당의 과제(오버레이·가방·전환을 한 타임라인에 올리기 위함).
 *    승격해도 start/stop/setTile 공개 API는 유지할 것.
 */

import * as THREE from 'three';
import type { PatternTile } from '../contracts.ts';
import type { Segmenter } from '../vision/segmenter.ts';

const PATTERN_SCALE = 0.35; // 실루엣 위 타일 반복 크기

const VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  uniform sampler2D uMask;
  uniform sampler2D uPattern;
  uniform float uPatternScale;

  varying vec2 vUv;

  void main() {
    // 화면의 video가 거울 모드이므로 mask도 좌우 반전
    vec2 mirrorUv = vec2(1.0 - vUv.x, vUv.y);

    float maskAlpha = texture2D(uMask, mirrorUv).a;

    // 기존 PATTERN_SCALE처럼 패턴을 반복
    vec2 patternUv = mirrorUv / uPatternScale;
    vec4 patternColor = texture2D(uPattern, patternUv);

    // 기존 Canvas의 source-in 역할
    gl_FragColor = vec4(
      patternColor.rgb,
      patternColor.a * maskAlpha
    );
    #include <colorspace_fragment>
  }
`;


export class OverlayLayer {
  private running = false;
  //private tile: PatternTile | null = null;
  private patternTexture: THREE.Texture | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly material: THREE.ShaderMaterial;
  private readonly plane: THREE.Mesh;

  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskContext: CanvasRenderingContext2D;
  private readonly maskTexture: THREE.CanvasTexture;

  

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly segmenter: Segmenter,
  ) {
      // 최종 화면을 그릴 WebGL renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setClearColor(0x000000, 0);

    // F-03 테스트용 임시 Scene
    this.scene = new THREE.Scene();

    // 화면 전체 Plane을 정면에서 보기 위한 카메라
    this.camera = new THREE.OrthographicCamera(
      -1,
      1,
      1,
      -1,
      0.1,
      10,
    );
    this.camera.position.z = 1;

    // Segmenter의 ImageBitmap mask를 Texture로 전달하기 위한 중간 Canvas
    this.maskCanvas = document.createElement('canvas');

    const maskContext = this.maskCanvas.getContext('2d');
    if (!maskContext) {
      throw new Error('마스크 2D 컨텍스트를 만들 수 없습니다');
    }
    this.maskContext = maskContext;

    this.maskTexture = new THREE.CanvasTexture(this.maskCanvas);
    this.maskTexture.minFilter = THREE.LinearFilter;
    this.maskTexture.magFilter = THREE.LinearFilter;
    this.maskTexture.generateMipmaps = false;

    // mask + pattern을 합성하는 Shader
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: this.maskTexture },
        uPattern: { value: null },
        uPatternScale: { value: PATTERN_SCALE },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    // 화면 전체를 덮는 납작한 판
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.plane = new THREE.Mesh(geometry, this.material);

    this.scene.add(this.plane);
  }

  setTile(tile: PatternTile): void {
  const next = new THREE.Texture(tile.bitmap);
  next.colorSpace = THREE.SRGBColorSpace;
  next.wrapS = next.wrapT = THREE.RepeatWrapping;
  next.needsUpdate = true;

  this.patternTexture?.dispose();
  this.patternTexture = next;

  this.material.uniforms['uPattern']!.value = next;
}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
  const width = this.video.videoWidth || 960;
  const height = this.video.videoHeight || 720;

  this.renderer.setSize(width, height, false);

  while (this.running) {
    await this.segmenter.send(this.video);

    const mask = this.segmenter.latest;

    if (mask && this.patternTexture) {
      // mask 크기가 바뀌면 중간 canvas도 맞춘다
      if (
        this.maskCanvas.width !== mask.width ||
        this.maskCanvas.height !== mask.height
      ) {
        this.maskCanvas.width = mask.width;
        this.maskCanvas.height = mask.height;
      }

      // Segmenter가 준 mask ImageBitmap을 중간 canvas에 복사
      this.maskContext.clearRect(
        0,
        0,
        this.maskCanvas.width,
        this.maskCanvas.height,
      );

      this.maskContext.drawImage(
        mask,
        0,
        0,
        this.maskCanvas.width,
        this.maskCanvas.height,
      );

      // GPU에게 mask Texture가 바뀌었다고 알림
      this.maskTexture.needsUpdate = true;

      // Shader → Plane → Scene을 실제 overlayCanvas에 그림
      this.renderer.render(this.scene, this.camera);
    } else {
      this.renderer.clear();
    }

    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  this.renderer.clear();
}
}
