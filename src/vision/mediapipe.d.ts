/**
 * MediaPipe SelfieSegmentation (classic, CDN 전역) 타입 선언.
 *
 * ⚠️ ADR-003: 이 CDN classic 빌드는 오프라인 불가 → `@mediapipe/tasks-vision` +
 *    `public/models/` 로컬 번들로 교체 예정. 교체되면 이 파일은 삭제된다. (A 담당)
 */

export interface SelfieSegmentationResults {
  image: CanvasImageSource;
  segmentationMask: CanvasImageSource;
}

export interface SelfieSegmentationOptions {
  modelSelection?: 0 | 1;
  selfieMode?: boolean;
}

declare global {
  class SelfieSegmentation {
    constructor(config: { locateFile: (file: string) => string });
    setOptions(options: SelfieSegmentationOptions): void;
    onResults(callback: (results: SelfieSegmentationResults) => void): void;
    send(input: { image: CanvasImageSource }): Promise<void>;
    close(): Promise<void>;
  }
}
