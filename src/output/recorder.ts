/**
 * D · Recorder / Uploader / QR — 결과물 파이프라인 (F-05, ADR-005·007)
 *
 * 🚧 W1 스텁: 계약 시그니처만 있다. D 담당의 W1 과제는 "MediaRecorder 검증"이며,
 *    구현 순서는 ARCHITECTURE §11-6 (Recorder 스파이크 → Uploader/세션 코드).
 *    - 8초 세로 영상 (mp4 h264 지원 시 우선, 아니면 webm + 포스터 이미지 폴백)
 *    - 업로드 실패 시 재시도 큐 + 세션 코드 발급 (오프라인 생존)
 */
import type { DeliveryTicket, PatternTile, ResultPackage } from '../contracts.ts';

export const CLIP_SECONDS = 8;

export interface RecordOptions {
  sessionId: string;
  patternName: string;
  tileMeta: PatternTile['meta'];
  seconds?: number;
}

/** 렌더 캔버스를 8초 녹화해 ResultPackage 로 묶는다. */
export async function record(
  _canvas: HTMLCanvasElement,
  _options: RecordOptions,
): Promise<ResultPackage> {
  // TODO(D): MediaRecorder(canvas.captureStream()) + mp4/webm 분기 + posterImage
  throw new Error('미구현 — D 모듈 W1 과제 (MediaRecorder 스파이크)');
}

/** 업로드 성공 시 url 티켓, 실패 시 로컬 큐에 넣고 세션 코드 티켓. */
export async function deliver(_pkg: ResultPackage): Promise<DeliveryTicket> {
  // TODO(D): 백그라운드 업로드 + 재시도 큐 (ADR-005)
  throw new Error('미구현 — D 모듈 과제 (Uploader/세션 코드)');
}
