/**
 * A · CaptureService — 웹캠 스트림 획득/해제
 * 스켈레톤 `btnStart` 핸들러 이식. (ARCHITECTURE §3 CAP)
 */

export interface CaptureOptions {
  width?: number;
  height?: number;
}

export class CaptureService {
  private stream: MediaStream | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  async start({ width = 960, height = 720 }: CaptureOptions = {}): Promise<MediaStream> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width, height },
      audio: false,
    });
    this.video.srcObject = this.stream;
    return this.stream;
  }

  /** RESET 시 호출 — 원본 프레임은 어디에도 남기지 않는다 (원칙 4). */
  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get isActive(): boolean {
    return this.stream !== null;
  }
}
