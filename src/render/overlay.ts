/**
 * C · OverlayLayer (F-03) — 실루엣 오버레이
 * 스켈레톤 `segLoop()` 이식. 마스크 안쪽에만 타일을 합성한다.
 *
 * ⚠️ ADR-004: 여기 2D 캔버스 합성은 v0 검증용. three.js 단일 씬의 **셰이더 플레인**으로
 *    승격하는 것이 C 담당의 과제(오버레이·가방·전환을 한 타임라인에 올리기 위함).
 *    승격해도 start/stop/setTile 공개 API는 유지할 것.
 */
import type { PatternTile } from '../contracts.ts';
import type { Segmenter } from '../vision/segmenter.ts';

const PATTERN_SCALE = 0.35; // 실루엣 위 타일 반복 크기
const FIRST_FRAME_TIMEOUT_MS = 8000;

export class OverlayLayer {
  private running = false;
  private tile: PatternTile | null = null;
  private renderedFrameCount = 0;
  private readonly frameWaiters = new Set<() => void>();

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly segmenter: Segmenter,
  ) {}

  setTile(tile: PatternTile): void {
    this.tile = tile;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  ensureRunningAndWaitForFrame(timeoutMs = FIRST_FRAME_TIMEOUT_MS): Promise<void> {
    const frameReady = this.waitForFrame(timeoutMs);
    this.start();
    return frameReady;
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
    const oc = this.canvas;
    const ox = oc.getContext('2d');
    if (!ox) throw new Error('2D 컨텍스트를 만들 수 없습니다');

    oc.width = this.video.videoWidth || 960;
    oc.height = this.video.videoHeight || 720;

    const pat = document.createElement('canvas');
    pat.width = oc.width;
    pat.height = oc.height;
    const px = pat.getContext('2d');
    if (!px) throw new Error('2D 컨텍스트를 만들 수 없습니다');

    while (this.running) {
      await this.segmenter.send(this.video);
      const mask = this.segmenter.latest;
      ox.clearRect(0, 0, oc.width, oc.height);

      if (mask && this.tile) {
        const p = px.createPattern(this.tile.bitmap, 'repeat');
        if (!p) {
          await new Promise((r) => requestAnimationFrame(r));
          continue;
        }

        ox.save();
        ox.translate(oc.width, 0);
        ox.scale(-1, 1); // 거울 모드 정합
        ox.drawImage(mask, 0, 0, oc.width, oc.height); // ① 사람 마스크
        ox.globalCompositeOperation = 'source-in'; // ② 마스크 안에만

        px.clearRect(0, 0, pat.width, pat.height);
        px.save();
        px.scale(PATTERN_SCALE, PATTERN_SCALE);
        px.fillStyle = p;
        px.fillRect(0, 0, pat.width / PATTERN_SCALE, pat.height / PATTERN_SCALE);
        px.restore();

        ox.drawImage(pat, 0, 0); // ③ 패턴 주입
        ox.restore();
        ox.globalCompositeOperation = 'source-over';
        this.notifyFrameRendered();
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    ox.clearRect(0, 0, oc.width, oc.height);
  }

  private notifyFrameRendered(): void {
    this.renderedFrameCount += 1;
    for (const resolve of this.frameWaiters) {
      resolve();
    }
    this.frameWaiters.clear();
  }
}
