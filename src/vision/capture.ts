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
    // 평문 HTTP(비보안 컨텍스트)에서는 mediaDevices 자체가 undefined 다 —
    // 원인 불명의 TypeError 대신 운영자가 조치할 수 있는 문구로 바꾼다.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? '이 브라우저는 카메라(getUserMedia)를 지원하지 않습니다.'
          : '카메라는 HTTPS 또는 localhost 에서만 열립니다. 키오스크는 로컬 실행(npm run preview)으로 돌리거나, 운영자는 Shift+D 데모 모드를 사용하세요.',
      );
    }
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
