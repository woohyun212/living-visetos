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
const FIRST_FRAME_TIMEOUT_MS = 8000; // 녹화 게이트: 첫 마스크 프레임 대기 상한

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
  uniform vec2 uResolution;
  uniform float uTilePx;

  varying vec2 vUv;

  void main() {
    // 화면의 video가 거울 모드이므로 mask도 좌우 반전
    vec2 mirrorUv = vec2(1.0 - vUv.x, vUv.y);

    float maskAlpha = texture2D(uMask, mirrorUv).a;

    // 기존 PATTERN_SCALE처럼 패턴을 반복
    vec2 patternUv = (mirrorUv * uResolution) / uTilePx;    
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
  private patternTexture: THREE.Texture | null = null;
  /** 녹화 게이트(F-05): 렌더된 프레임 수·대기자 — 첫 프레임 전 캡처(투명 포스터)를 막는다 */
  private renderedFrameCount = 0;
  private readonly frameWaiters = new Set<() => void>();
  /** 렌더 직후 동기 구독자(세로 녹화 합성기) — waitForFrame 의 1회성 대기자와 달리 계속 남는다. */
  private readonly frameListeners = new Set<() => void>();

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
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTilePx: { value: 1024 * PATTERN_SCALE },
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

  /** 오버레이를 켜고(이미 켜져 있으면 그대로) 다음 렌더 프레임까지 기다린다 — 녹화·포스터 캡처 전 게이트. */
  ensureRunningAndWaitForFrame(timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<void> {
    const frameReady = this.waitForFrame(timeoutMs);
    this.start();
    return frameReady;
  }

  /**
   * 렌더 직후(동기)에 불리는 콜백을 건다. 해제 함수를 돌려준다.
   * ⚠️ 이 캔버스는 preserveDrawingBuffer:false 이므로 drawImage 로 픽셀을 읽을 수 있는
   *    유일한 창이 이 콜백 안이다(D · output/portrait.ts 의 세로 합성이 여기에 붙는다).
   */
  onFrameRendered(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  waitForFrame(timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<void> {
    const frameCount = this.renderedFrameCount;

    return new Promise((resolve, reject) => {
      const done = () => {
        if (this.renderedFrameCount <= frameCount) {
          return;
        }
        globalThis.clearTimeout(timeout);
        this.frameWaiters.delete(done);
        resolve();
      };
      const timeout = globalThis.setTimeout(() => {
        this.frameWaiters.delete(done);
        reject(new Error('Overlay first mask frame was not ready in time.'));
      }, timeoutMs);
      this.frameWaiters.add(done);
    });
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
  const width = this.video.videoWidth || 960;
  const height = this.video.videoHeight || 720;

  this.renderer.setSize(width, height, false);
  this.material.uniforms['uResolution']!.value.set(width, height);

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
      this.notifyFrameRendered();
    } else {
      this.renderer.clear();
    }

    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  this.renderer.clear();
}

  private notifyFrameRendered(): void {
    this.renderedFrameCount += 1;

    // 구독자 먼저 — 아직 백버퍼가 살아 있는 이 순간에만 픽셀을 복사할 수 있다.
    for (const listener of this.frameListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[overlay] 프레임 구독자 오류', error);
      }
    }

    for (const resolve of this.frameWaiters) {
      resolve();
    }
    this.frameWaiters.clear();
  }
}
