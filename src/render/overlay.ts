/**
 * C · OverlayLayer (F-03) — 실루엣 오버레이
 * 스켈레톤 `segLoop()` 이식. 마스크 안쪽에만 타일을 합성한다.
 *
 * ✅ ADR-004 이행: three.js 씬의 셰이더 플레인. start/stop/setTile 공개 API는 그대로다.
 *
 * ⚠️ 생명주기: 이 인스턴스는 **페이지 수명 내내 하나**이고 `dispose()` 는 RESET 마다 불린다.
 *    그래서 dispose 는 "파기 후 다시 쓸 수 있는" 파기다 — GPU 자원 묶음(OverlayGpu)만
 *    통째로 놓고, 다음 setTile()/start() 가 ensureGpu() 로 새로 세운다.
 *    three r160 의 renderer.dispose() 는 컨텍스트를 잃지 않으므로(forceContextLoss 는 별도 함수)
 *    같은 캔버스 위에 renderer 를 다시 올릴 수 있다.
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

/** RESET 마다 통째로 놓았다가 다시 세우는 GPU 자원 묶음. null 인 것이 곧 "파기됨" 표시다. */
interface OverlayGpu {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
  geometry: THREE.PlaneGeometry;
  /** Segmenter 의 ImageBitmap 마스크를 텍스처로 넘기기 위한 중간 캔버스. */
  maskCanvas: HTMLCanvasElement;
  maskContext: CanvasRenderingContext2D;
  maskTexture: THREE.CanvasTexture;
}

/** 첫 마스크 프레임 대기자 — 프레임이 오면 인자 없이, 파기되면 오류와 함께 불린다. */
type FrameWaiter = (error?: Error) => void;

export class OverlayLayer {
  private running = false;
  private gpu: OverlayGpu | null = null;
  private patternTexture: THREE.Texture | null = null;
  /** 파기 세대 — dispose() 마다 1 오른다. 늦게 깨어난 루프가 이 값으로 자기가 낡았음을 안다. */
  private generation = 0;
  /** 녹화 게이트(F-05): 렌더된 프레임 수·대기자 — 첫 프레임 전 캡처(투명 포스터)를 막는다 */
  private renderedFrameCount = 0;
  private readonly frameWaiters = new Set<FrameWaiter>();

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly segmenter: Segmenter,
  ) {}

  setTile(tile: PatternTile): void {
    const gpu = this.ensureGpu();

    const next = new THREE.Texture(tile.bitmap);
    next.colorSpace = THREE.SRGBColorSpace;
    next.wrapS = next.wrapT = THREE.RepeatWrapping;
    next.needsUpdate = true;

    this.patternTexture?.dispose();
    this.patternTexture = next;

    gpu.material.uniforms['uPattern']!.value = next;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    void this.loop(generation).catch((error) => {
      if (generation !== this.generation) return; // 파기된 세션의 뒤늦은 오류는 삼킨다
      console.warn('[overlay] 렌더 루프가 중단되었습니다', error);
    });
  }

  /** 오버레이를 켜고(이미 켜져 있으면 그대로) 다음 렌더 프레임까지 기다린다 — 녹화·포스터 캡처 전 게이트. */
  ensureRunningAndWaitForFrame(timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<void> {
    const frameReady = this.waitForFrame(timeoutMs);
    this.start();
    return frameReady;
  }

  waitForFrame(timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<void> {
    const frameCount = this.renderedFrameCount;

    return new Promise((resolve, reject) => {
      const settle: FrameWaiter = (error) => {
        if (!error && this.renderedFrameCount <= frameCount) return;
        globalThis.clearTimeout(timeout);
        this.frameWaiters.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      const timeout = globalThis.setTimeout(() => {
        this.frameWaiters.delete(settle);
        reject(new Error('Overlay first mask frame was not ready in time.'));
      }, timeoutMs);
      this.frameWaiters.add(settle);
    });
  }

  /**
   * 오버레이만 끈다 (세션은 그대로 — ?debug=1 의 '오버레이 끄기', 무대의 페이드아웃).
   *
   * 루프는 segmenter 를 기다리며 await 에 걸려 있을 수 있으므로, 마지막 실루엣 프레임이
   * 캔버스에 얼어붙지 않게 **여기서 동기적으로** 지운다. dispose() 와 같은 이유의 한 단계
   * 약한 버전 — GPU 자원은 그대로 두고 화면만 비운다.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.gpu?.renderer.clear();
  }

  /**
   * RESET 에서 부른다 (main.ts destroySession) — 앞 관객의 실루엣이 다음 사람 화면에
   * **잔상으로 남지 않게** 텍스처·마스크·renderer 를 놓고 캔버스를 비운다 (원칙 4).
   *
   * stop() 만으로는 부족하다: 루프가 `segmenter.send()` 앞에 멈춰 있는 동안
   * segmenter.dispose() 가 먼저 일어나면 루프 끝의 renderer.clear() 에 영영 닿지 못한다.
   * 그래서 여기서 동기적으로 지운다. 파기 후에도 같은 인스턴스를 계속 쓴다.
   */
  dispose(): void {
    this.running = false;
    this.generation += 1;
    this.renderedFrameCount = 0;
    this.settleFrameWaiters(new Error('Overlay was disposed before a mask frame arrived.'));

    const gpu = this.gpu;
    this.gpu = null;

    this.patternTexture?.dispose();
    this.patternTexture = null;

    if (gpu) {
      gpu.renderer.clear();
      gpu.maskContext.clearRect(0, 0, gpu.maskCanvas.width, gpu.maskCanvas.height);
      // 텍스처 dispose 는 renderer.dispose() 보다 **먼저** — 그래야 해제 이벤트가 GPU 까지 닿는다.
      gpu.maskTexture.dispose();
      gpu.material.dispose();
      gpu.geometry.dispose();
      gpu.scene.clear();
      gpu.renderer.dispose();
    }

    this.clearCanvas();
  }

  // ── 내부 ──────────────────────────────────────
  /** GPU 자원을 세운다. 이미 서 있으면 그대로 돌려준다 (파기 후 첫 호출이 다시 세운다). */
  private ensureGpu(): OverlayGpu {
    if (this.gpu) return this.gpu;

    // 최종 화면을 그릴 WebGL renderer
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();

    // 화면 전체 Plane을 정면에서 보기 위한 카메라
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 1;

    const maskCanvas = document.createElement('canvas');
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) throw new Error('마스크 2D 컨텍스트를 만들 수 없습니다');

    const maskTexture = new THREE.CanvasTexture(maskCanvas);
    maskTexture.minFilter = THREE.LinearFilter;
    maskTexture.magFilter = THREE.LinearFilter;
    maskTexture.generateMipmaps = false;

    // mask + pattern을 합성하는 Shader
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMask: { value: maskTexture },
        uPattern: { value: this.patternTexture },
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
    scene.add(new THREE.Mesh(geometry, material));

    this.gpu = {
      renderer,
      scene,
      camera,
      material,
      geometry,
      maskCanvas,
      maskContext,
      maskTexture,
    };
    return this.gpu;
  }

  private async loop(generation: number): Promise<void> {
    const gpu = this.ensureGpu();

    const width = this.video.videoWidth || 960;
    const height = this.video.videoHeight || 720;

    gpu.renderer.setSize(width, height, false);
    gpu.material.uniforms['uResolution']!.value.set(width, height);

    while (this.alive(generation, gpu)) {
      try {
        await this.segmenter.send(this.video);
      } catch (error) {
        // RESET 직후라면 segmenter 는 이미 파기됐다 — 낡은 루프의 오류는 조용히 끝낸다.
        if (!this.alive(generation, gpu)) return;
        throw error;
      }
      if (!this.alive(generation, gpu)) return;

      const mask = this.segmenter.latest;

      if (mask && this.patternTexture) {
        // mask 크기가 바뀌면 중간 canvas도 맞춘다
        if (gpu.maskCanvas.width !== mask.width || gpu.maskCanvas.height !== mask.height) {
          gpu.maskCanvas.width = mask.width;
          gpu.maskCanvas.height = mask.height;
        }

        // Segmenter가 준 mask ImageBitmap을 중간 canvas에 복사
        gpu.maskContext.clearRect(0, 0, gpu.maskCanvas.width, gpu.maskCanvas.height);
        gpu.maskContext.drawImage(mask, 0, 0, gpu.maskCanvas.width, gpu.maskCanvas.height);

        // GPU에게 mask Texture가 바뀌었다고 알림
        gpu.maskTexture.needsUpdate = true;

        // Shader → Plane → Scene을 실제 overlayCanvas에 그림
        gpu.renderer.render(gpu.scene, gpu.camera);
        this.notifyFrameRendered();
      } else {
        gpu.renderer.clear();
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  /** 이 루프가 아직 자기 세대의 GPU 자원 위에서 돌고 있는지 — await 뒤마다 확인한다. */
  private alive(generation: number, gpu: OverlayGpu): boolean {
    return this.running && this.generation === generation && this.gpu === gpu;
  }

  private notifyFrameRendered(): void {
    this.renderedFrameCount += 1;
    this.settleFrameWaiters();
  }

  /** 대기자를 모두 깨운다. error 가 있으면 거부 — 파기 중 8초를 헛되이 기다리지 않게. */
  private settleFrameWaiters(error?: Error): void {
    for (const settle of Array.from(this.frameWaiters)) settle(error);
  }

  /** renderer 없이도 확실히 지운다 — 드로잉 버퍼를 다시 잡으면 캔버스가 투명으로 돌아간다. */
  private clearCanvas(): void {
    this.canvas.width = this.canvas.width;
  }
}
