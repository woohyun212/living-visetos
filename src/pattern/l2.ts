/**
 * B · L2 GenAIPromoter — 비동기 품질 승격 (ARCHITECTURE §5 "L2 승격 프로토콜", ADR-002)
 *
 * 계약: L1 타일 표시 직후 요청 발사(타임아웃 8초). 도착하면 같은 채널로
 *       PatternTile{version:'L2'} 재발행 → 렌더는 크로스페이드로 스왑.
 *       실패·타임아웃이면 **아무 일도 일어나지 않는다**(L1 유지). UI는 L2의 존재를 모른다.
 *
 * 🚧 W1 스텁: 지금은 항상 null(=승격 없음). 실제 생성AI 연결은 B 담당의 과제.
 *    이 파일의 시그니처는 유지하고 내부만 구현할 것.
 */
import type { FeatureSeed, PatternTile } from '../contracts.ts';

export const L2_TIMEOUT_MS = 8000; // 성능 예산(ARCHITECTURE §8): 초과 시 포기

export interface PromoteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * @returns 승격 타일, 또는 실패·타임아웃 시 null (호출부는 null 이면 조용히 무시한다)
 */
export async function promoteToL2(
  _seed: FeatureSeed,
  _options: PromoteOptions = {},
): Promise<PatternTile | null> {
  // TODO(B): 생성AI 요청 → 1024 타일 수신 → Grammar Guard 통과 → version:'L2' 로 반환
  return null;
}
