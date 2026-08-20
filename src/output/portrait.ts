/**
 * D · PortraitComposer — 무대와 같은 그림을 1080×1920 세로 캔버스로 합성한다 (F-05).
 *
 * contracts.ts 의 `video: Blob // 8초 세로` 를 이행하기 위한 녹화 입력.
 * 무대(app/stage.ts)는 video 와 #overlayCanvas 를 같은 1080×1920 박스에 넣고
 * `object-fit: cover` 로 각각 자른다 — 여기서도 레이어마다 자기 고유 크기로
 * cover 크롭을 따로 계산해 같은 그림을 만든다(둘의 화면비가 달라도 어긋나지 않는다).
 *
 * ⚠️ #overlayCanvas 는 WebGL(preserveDrawingBuffer:false) 이라 렌더 직후의
 *    동기 실행 구간에서만 drawImage 로 읽을 수 있다. 그래서 합성 루프가 직접
 *    오버레이를 읽지 않고, 오버레이 렌더 콜백 안에서 2D 사본(mirror)을 한 장 떠 둔다.
 *    합성 rAF 루프는 사본만 보므로 세그멘테이션이 느려져도 실루엣이 깜빡이지 않는다.
 */

/** 무대와 같은 설계 해상도 (app/stage.ts STAGE_WIDTH/HEIGHT). */
export const PORTRAIT_WIDTH = 1080;
export const PORTRAIT_HEIGHT = 1920;

/** 첫 합성 프레임 대기 상한 — 여기서 걸리면 카메라/오버레이가 아직 준비되지 않은 것이다. */
export const FIRST_COMPOSED_FRAME_TIMEOUT_MS = 6000;

export interface CoverRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * `object-fit: cover` 와 같은 배치를 계산한다 — 짧은 쪽을 채우고 넘치는 쪽을 잘라낸다.
 * 무대 CSS 가 video/canvas 각각에 걸어 두는 것과 같은 규칙(레이어별로 따로 계산).
 */
export function coverRect(srcW: number, srcH: number, dstW: number, dstH: number): CoverRect {
  if (!(srcW > 0) || !(srcH > 0)) {
    return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  }

  const scale = Math.max(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { dx: (dstW - dw) / 2, dy: (dstH - dh) / 2, dw, dh };
}

export interface PortraitSource {
  /** 카메라 영상. 무대와 같이 좌우 반전(거울)해서 깐다. */
  video: HTMLVideoElement;
  /** 실루엣 오버레이 캔버스(WebGL). 셰이더가 이미 마스크를 뒤집으므로 반전하지 않는다. */
  overlayCanvas: HTMLCanvasElement;
  /** 오버레이 렌더 직후 동기 콜백 등록. 해제 함수를 돌려준다. */
  subscribeOverlayFrame(listener: () => void): () => void;
}

/** 세로 녹화용 합성기. start() 로 rAF 루프를 돌리고 stop() 으로 반드시 해제한다. */
export class PortraitComposer {
  readonly canvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly source: PortraitSource;
  /** 오버레이 WebGL 백버퍼의 2D 사본 — 합성 루프가 안전하게 읽을 수 있는 유일한 창구. */
  private readonly overlayMirror: HTMLCanvasElement;
  private readonly overlayMirrorCtx: CanvasRenderingContext2D;

  private raf: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private hasOverlayFrame = false;
  private composedFrames = 0;
  private readonly frameWaiters = new Set<() => void>();

  constructor(source: PortraitSource) {
    this.source = source;

    this.canvas = document.createElement('canvas');
    this.canvas.width = PORTRAIT_WIDTH;
    this.canvas.height = PORTRAIT_HEIGHT;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      throw new Error('Portrait canvas 2D context could not be created.');
    }
    this.ctx = ctx;

    this.overlayMirror = document.createElement('canvas');
    this.overlayMirror.width = 1;
    this.overlayMirror.height = 1;
    const mirrorCtx = this.overlayMirror.getContext('2d');
    if (!mirrorCtx) {
      throw new Error('Overlay mirror 2D context could not be created.');
    }
    this.overlayMirrorCtx = mirrorCtx;
  }

  get frameCount(): number {
    return this.composedFrames;
  }

  start(): void {
    if (this.raf !== null) {
      return;
    }

    this.unsubscribe = this.source.subscribeOverlayFrame(() => this.mirrorOverlay());
    this.raf = requestAnimationFrame(() => this.tick());
  }

  stop(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frameWaiters.clear();
    // 사본 백킹스토어를 즉시 반납한다 — 1080×1920 두 장을 세션 사이에 들고 있지 않는다.
    this.overlayMirror.width = this.overlayMirror.height = 1;
    this.hasOverlayFrame = false;
  }

  /** 실제 그림이 한 장 이상 깔린 뒤를 기다린다 — 검은 포스터·빈 클립 방지. */
  waitForFrame(timeoutMs = FIRST_COMPOSED_FRAME_TIMEOUT_MS): Promise<void> {
    if (this.composedFrames > 0) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const done = (): void => {
        globalThis.clearTimeout(timer);
        this.frameWaiters.delete(done);
        resolve();
      };
      const timer = globalThis.setTimeout(() => {
        this.frameWaiters.delete(done);
        reject(new Error('Portrait composer produced no frame in time.'));
      }, timeoutMs);
      this.frameWaiters.add(done);
    });
  }

  /** 오버레이 렌더 직후(동기) — 여기서만 WebGL 캔버스를 읽을 수 있다. */
  private mirrorOverlay(): void {
    const source = this.source.overlayCanvas;
    if (source.width <= 0 || source.height <= 0) {
      return;
    }

    if (this.overlayMirror.width !== source.width || this.overlayMirror.height !== source.height) {
      this.overlayMirror.width = source.width;
      this.overlayMirror.height = source.height;
    }

    this.overlayMirrorCtx.clearRect(0, 0, this.overlayMirror.width, this.overlayMirror.height);
    this.overlayMirrorCtx.drawImage(source, 0, 0);
    this.hasOverlayFrame = true;
  }

  private tick(): void {
    this.raf = requestAnimationFrame(() => this.tick());
    this.compose();
  }

  private compose(): void {
    const { video } = this.source;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    if (!(videoW > 0) || !(videoH > 0)) {
      return; // 카메라 메타데이터 전 — 검은 프레임을 굳이 만들지 않는다.
    }

    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);

    // 1) 카메라(거울) — 무대의 `transform: scaleX(-1)` 과 같은 그림.
    const videoRect = coverRect(videoW, videoH, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
    ctx.save();
    ctx.translate(PORTRAIT_WIDTH, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, videoRect.dx, videoRect.dy, videoRect.dw, videoRect.dh);
    ctx.restore();

    // 2) 실루엣 오버레이 — 셰이더가 이미 뒤집었으므로 반전 없이 같은 cover 로 얹는다.
    if (this.hasOverlayFrame) {
      const overlayRect = coverRect(
        this.overlayMirror.width,
        this.overlayMirror.height,
        PORTRAIT_WIDTH,
        PORTRAIT_HEIGHT,
      );
      ctx.drawImage(
        this.overlayMirror,
        overlayRect.dx,
        overlayRect.dy,
        overlayRect.dw,
        overlayRect.dh,
      );
    }

    this.composedFrames += 1;
    if (this.frameWaiters.size > 0) {
      for (const resolve of [...this.frameWaiters]) {
        resolve();
      }
    }
  }
}
