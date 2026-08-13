/**
 * A · Segmenter (F-03 입력)
 * 스켈레톤 `initSeg()` 이식. 출력 계약: MaskFrame = ImageBitmap (프레임 단위 스트림)
 *
 * ⚠️ ADR-003: 지금은 CDN classic `SelfieSegmentation`(index.html의 <script>) 사용 →
 *    오프라인 불가. `@mediapipe/tasks-vision` + `public/models/` 로컬 모델로 교체하는 것이
 *    A 담당의 W1 과제. 교체해도 이 클래스의 공개 API(latest / send)는 유지할 것.
 */
import type { MaskFrame } from '../contracts.ts';

const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation';

const FRAME_TIMEOUT_MS = 2000; // 결과가 안 오면 조용히 멈추지 말고 경고

export class Segmenter {
  private seg: SelfieSegmentation | null = null;
  private mask: MaskFrame | null = null;
  /** 지금 보낸 프레임 전용 deferred — 이전 프레임 것을 기다리지 않도록 매 send 마다 새로 만든다. */
  private frameDone: (() => void) | null = null;
  private warned = false;

  init(): void {
    if (this.seg) return;
    this.seg = new SelfieSegmentation({ locateFile: (f) => `${CDN_BASE}/${f}` });
    this.seg.setOptions({ modelSelection: 1 });
    this.seg.onResults((res) => {
      // 계약(MaskFrame=ImageBitmap)으로 정규화. 이전 프레임은 즉시 반납.
      void createImageBitmap(res.segmentationMask as ImageBitmapSource)
        .then((bmp) => {
          this.mask?.close();
          this.mask = bmp;
        })
        .finally(() => this.frameDone?.());
    });
  }

  /** 한 프레임 세그멘테이션. 완료(또는 타임아웃) 후 latest 가 최신이다. */
  async send(video: HTMLVideoElement): Promise<void> {
    if (!this.seg) this.init();
    const done = new Promise<void>((resolve) => {
      this.frameDone = resolve;
      void this.seg!.send({ image: video }).catch(resolve);
    });
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), FRAME_TIMEOUT_MS));
    if ((await Promise.race([done, timeout])) === 'timeout' && !this.warned) {
      this.warned = true;
      console.warn('[segmenter] 마스크 프레임이 오지 않습니다 — 모델 로딩/네트워크 확인 (ADR-003)');
    }
    this.frameDone = null;
  }

  get latest(): MaskFrame | null {
    return this.mask;
  }

  dispose(): void {
    this.mask?.close();
    this.mask = null;
    void this.seg?.close();
    this.seg = null;
  }
}
