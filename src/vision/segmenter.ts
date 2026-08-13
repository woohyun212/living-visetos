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

export class Segmenter {
  private seg: SelfieSegmentation | null = null;
  private mask: MaskFrame | null = null;
  private pending: Promise<void> | null = null;

  init(): void {
    if (this.seg) return;
    this.seg = new SelfieSegmentation({ locateFile: (f) => `${CDN_BASE}/${f}` });
    this.seg.setOptions({ modelSelection: 1 });
    this.seg.onResults((res) => {
      // 계약(MaskFrame=ImageBitmap)으로 정규화. 이전 프레임은 즉시 반납.
      this.pending = createImageBitmap(res.segmentationMask as ImageBitmapSource).then((bmp) => {
        this.mask?.close();
        this.mask = bmp;
      });
    });
  }

  /** 한 프레임 세그멘테이션. 완료 시 latest 가 갱신된다. */
  async send(video: HTMLVideoElement): Promise<void> {
    if (!this.seg) this.init();
    await this.seg!.send({ image: video });
    await this.pending;
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
