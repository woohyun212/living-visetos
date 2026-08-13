/**
 * src/contracts.ts — 모듈 간 국경 (contracts v1)
 *
 * 출처: ARCHITECTURE.md §5 "데이터 플로우와 계약 (contracts.ts v1)" — 그대로 이식.
 *       ARCHITECTURE.md §11-1 "리포 생성 + contracts.ts v1 커밋 — 이 문서 5장 그대로"
 *
 * ⚠️ DEV_SETUP.md §3의 초안 계약을 **대체**합니다. 차이점:
 *   - FeatureSeed 에 sessionId 추가
 *   - PatternTile.bitmap 은 ImageBitmap 으로 고정(캔버스 허용 안 함), version('L1'|'L2') 추가,
 *     meta 에 motifDensity 추가
 *   - ResultPackage / DeliveryTicket 신규
 *   - KioskState 에 CONSENT / RESET / ERROR_RECOVER 추가 (동의를 상태로 승격)
 *
 * 변경 규칙 (DEV_SETUP.md §5): 이 파일의 변경은 팀 합의 + PR 리뷰 2인.
 */

// ── 스트림 (30fps 목표) ──────────────────────────
export type MaskFrame = ImageBitmap; // Segmenter → OverlayLayer

// ── 이벤트 (세션당 1~수 회) ──────────────────────
export interface FeatureSeed {
  dominantColors: [string, string, string];
  motionEnergy: number; // 0~1
  rhythm: number; // 0~1
  sessionId: string;
}

export interface PatternTile {
  bitmap: ImageBitmap; // 1024px 반복 타일
  version: 'L1' | 'L2'; // 무중단 승격의 키
  meta: {
    palette: string[];
    spacing: number;
    motifDensity: number;
    seedRef: string;
  };
}

export interface ResultPackage {
  sessionId: string;
  video: Blob; // 8초 세로 (mp4 우선, webm 폴백)
  posterImage: Blob; // iOS 폴백 겸 썸네일
  certificate: {
    patternName: string;
    issuedAt: string;
    tileMeta: PatternTile['meta'];
  };
}

export type DeliveryTicket =
  | { kind: 'url'; url: string } // 업로드 성공 → QR
  | { kind: 'code'; code: string }; // 오프라인 → 세션 코드 (나중 조회)

export type KioskState =
  | 'ATTRACT'
  | 'CONSENT'
  | 'CREATE'
  | 'TRANSFORM'
  | 'MATERIALIZE'
  | 'OWN'
  | 'RESET'
  | 'ERROR_RECOVER';
