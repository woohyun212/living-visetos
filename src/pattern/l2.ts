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
import { resolveTileSize, type SupportedTileSize } from './constants.ts';
import { isPatternTileValid } from './guard.ts';

export const L2_TIMEOUT_MS = 8000; // 성능 예산(ARCHITECTURE §8): 초과 시 포기

/**
 * L2 승격 타일의 단일 관문. 생성AI 결과라도 계약(크기·팔레트·메타)을 통과하지
 * 못하면 화면에 올리지 않고 null 로 떨어뜨려 L1 을 유지한다. 실제 생성AI 연결
 * (TODO(B))은 반드시 이 함수를 거쳐 반환할 것 — 호출부는 이미 통과했다고 가정한다.
 */
export function acceptPromotedTile(
  tile: PatternTile | null | undefined,
  tileSize: SupportedTileSize = resolveTileSize(undefined),
): PatternTile | null {
  if (isPatternTileValid(tile, tileSize, 'L2')) return tile;
  if (tile) console.warn('[pattern:L2] 승격 타일이 계약 검증에 실패해 L1을 유지합니다');
  return null;
}

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
  // TODO(B): 생성AI 요청 → 1024 타일 수신 → version:'L2' 로 구성 후 acceptPromotedTile 통과
  return acceptPromotedTile(null);
}
