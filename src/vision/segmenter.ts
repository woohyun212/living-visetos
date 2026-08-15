/**
 * A · Segmenter (F-03 입력)
 * 출력 계약: MaskFrame = ImageBitmap (프레임 단위 스트림)
 *
 * ADR-003 이행: `@mediapipe/tasks-vision` ImageSegmenter + 로컬 번들.
 *   - wasm 런타임: public/wasm/ (scripts/sync-mediapipe-wasm.mjs 가 node_modules 에서 복사)
 *   - 모델: public/models/selfie_segmenter.tflite (float16, MediaPipe 공식 배포본)
 *   → 첫 실행부터 인터넷 없이 동작한다 (원칙 1).
 *
 * 마스크 품질: confidence mask 를 smoothstep 알파 그라데이션으로 변환 + 소량 블러
 * → 경계가 페더링된 알파 마스크. OverlayLayer 의 source-in 합성에서 가장자리가 부드럽다.
 *
 * 공개 API(init / send / latest / dispose)는 v0 과 동일 — C 모듈은 그대로 쓴다.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { MaskFrame } from '../contracts.ts';

const WASM_BASE = '/wasm'; // public/wasm — 로컬 정적 자산
const MODEL_PATH = '/models/selfie_segmenter.tflite';

/** confidence → 알파 그라데이션 구간. LO 이하 = 투명, HI 이상 = 불투명, 사이 = smoothstep. */
const FEATHER_LO = 0.3;
const FEATHER_HI = 0.8;
/** 그라데이션 위에 추가로 얹는 블러 페더링(px, 마스크 해상도 기준). */
const FEATHER_BLUR_PX = 2;

/** 성능 예산(ARCHITECTURE §8): 마스크 스트림 24fps 이상 @720p — N프레임마다 콘솔에 측정치. */
const FPS_LOG_EVERY = 120;

export class Segmenter {
  private seg: ImageSegmenter | null = null;
  private initPromise: Promise<void> | null = null;
  private mask: MaskFrame | null = null;
  private lastTs = 0;

  // 프레임마다 재사용하는 버퍼 (해상도가 바뀌면 다시 만든다)
  private alphaCanvas: HTMLCanvasElement | null = null;
  private featherCanvas: HTMLCanvasElement | null = null;
  private imageData: ImageData | null = null;

  // fps 측정
  private frameCount = 0;
  private fpsWindowStart = 0;

  /** wasm + 모델 로딩. 여러 번 불려도 1회만 수행. */
  init(): Promise<void> {
    this.initPromise ??= (async () => {
      const t0 = performance.now();
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.seg = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      console.info(
        `[perf] segmenter init ${Math.round(performance.now() - t0)}ms · ` +
          `labels=[${this.seg.getLabels().join(',')}] · 로컬 번들(오프라인)`,
      );
    })();
    return this.initPromise;
  }

  /** 한 프레임 세그멘테이션. 완료 후 latest 가 최신 페더링 마스크다. */
  async send(video: HTMLVideoElement): Promise<void> {
    await this.init();
    if (!video.videoWidth) return; // 카메라 프레임이 아직 없다

    // VIDEO 모드는 단조 증가 타임스탬프를 요구한다
    const ts = Math.max(performance.now(), this.lastTs + 1);
    this.lastTs = ts;

    let featherSrc: HTMLCanvasElement | null = null;
    this.seg!.segmentForVideo(video, ts, (result) => {
      // 마스크 버퍼는 콜백 밖에서 무효화되므로 CPU 변환은 콜백 안에서 끝낸다.
      const masks = result.confidenceMasks;
      if (!masks?.length) return;
      // selfie_segmenter 는 [background, person] 순 — 마지막 마스크가 인물 confidence.
      const m = masks[masks.length - 1]!;
      featherSrc = this.confidenceToAlphaCanvas(m.getAsFloat32Array(), m.width, m.height);
    });

    if (featherSrc) {
      const bmp = await createImageBitmap(featherSrc);
      this.mask?.close();
      this.mask = bmp;
      this.tickFps(bmp.width, bmp.height);
    }
  }

  get latest(): MaskFrame | null {
    return this.mask;
  }

  dispose(): void {
    this.mask?.close();
    this.mask = null;
    this.seg?.close();
    this.seg = null;
    this.initPromise = null;
  }

  /** confidence(Float32) → 흰색 + smoothstep 알파 → 블러 페더링 캔버스. */
  private confidenceToAlphaCanvas(conf: Float32Array, w: number, h: number): HTMLCanvasElement {
    if (!this.imageData || this.imageData.width !== w || this.imageData.height !== h) {
      this.imageData = new ImageData(w, h);
      this.imageData.data.fill(255); // RGB 는 항상 흰색 — 알파만 갱신한다
      this.alphaCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
      this.featherCanvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    }
    const data = this.imageData.data;
    const span = FEATHER_HI - FEATHER_LO;
    for (let i = 0; i < conf.length; i++) {
      let a = (conf[i]! - FEATHER_LO) / span;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      a = a * a * (3 - 2 * a); // smoothstep
      data[i * 4 + 3] = (a * 255) | 0;
    }
    const ax = this.alphaCanvas!.getContext('2d')!;
    ax.putImageData(this.imageData, 0, 0);

    const fx = this.featherCanvas!.getContext('2d')!;
    fx.clearRect(0, 0, w, h);
    fx.filter = `blur(${FEATHER_BLUR_PX}px)`;
    fx.drawImage(this.alphaCanvas!, 0, 0);
    fx.filter = 'none';
    return this.featherCanvas!;
  }

  private tickFps(w: number, h: number): void {
    if (this.frameCount === 0) this.fpsWindowStart = performance.now();
    if (++this.frameCount % FPS_LOG_EVERY === 0) {
      const sec = (performance.now() - this.fpsWindowStart) / 1000;
      console.info(
        `[perf] 마스크 스트림 ${(FPS_LOG_EVERY / sec).toFixed(1)}fps @${w}x${h} (예산 24fps↑)`,
      );
      this.frameCount = 0;
    }
  }
}
