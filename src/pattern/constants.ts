/** F-02 공통 상수 — 기획 가드레일과 ARCHITECTURE 성능 예산의 단일 출처. */
export const DEFAULT_TILE_SIZE = 1024;
export const SUPPORTED_TILE_SIZES = [512, 1024] as const;
export type SupportedTileSize = (typeof SUPPORTED_TILE_SIZES)[number];

export const BASE_TILE_SIZE = 1024;
export const COGNAC = '#A9652C';
export const DARK = '#3A2A18';
export const CREAM = '#F2E7D2';
export const BRAND_PALETTE = [COGNAC, DARK, CREAM] as const;

export const MAX_ACCENT_MIX = 0.35;
/** FeatureSeed 색상 역할은 motionEnergy와 분리된 고정 혼합률을 사용한다. */
export const BACKGROUND_USER_COLOR_MIX = 0.22;
export const DIAMOND_USER_COLOR_MIX = 0.30;
export const EMBLEM_USER_COLOR_MIX = 0.30;
/** 자체 모티프의 보수적인 외곽 반경과 인접 모티프 사이 최소 여백(1024px 기준). */
export const MOTIF_EXTENT_FACTOR = 1.35;
/** 자체 엠블럼 5종 중 가장 넓은 ribbon-loop의 실제 가로 폭 계수. */
export const EMBLEM_WIDTH_FACTOR = 1.76;
export const MIN_MOTIF_SPACING_MARGIN = 8;
export const MIN_MOTIF_PAIR_MARGIN = 8;
export const MIN_CELL_BOUNDARY_MARGIN = 4;
/** 축소·가방 표면에서도 점이 아닌 정방향 마름모로 읽히는 긴 대각선 비율. */
export const DIAMOND_LONG_DIAGONAL_RATIO = { min: 0.34, max: 0.40 } as const;
export const MIN_DIAMOND_LONG_DIAGONAL = 24;
export const MIN_EMBLEM_VISUAL_SIZE = 36;
/** 다이아몬드 색상 출현 비율과 결정적 20칸 교대 주기의 Guard. */
export const DIAMOND_COLOR_RATIO_LIMITS = {
  primary: { min: 0.65, max: 0.80 },
  secondary: { min: 0.15, max: 0.25 },
  accent: { min: 0.05, max: 0.10 },
} as const;
export const DIAMOND_COLOR_CYCLE_LENGTH = 20;
/** 0~255 가중 명도 기준. 사용자색 혼합을 낮춰서 확보하는 최소 차이. */
export const MIN_DIAMOND_BACKGROUND_LUMINANCE_DELTA = 42;
export const EMBLEM_VISUAL_SIZE_RATIO = { min: 0.52, max: 0.64 } as const;

/** 모든 픽셀 범위는 1024px 타일 기준이며 512px에서는 비율로 축소한다. */
export const GRAMMAR_LIMITS = {
  gridSpacing: { min: 64, max: 132 },
  gridLineWidth: { min: 2.5, max: 5.5 },
  motifRadius: { min: 18, max: 44 },
  motifFrequency: { min: 2, max: 5 },
  accentMix: { min: 0, max: MAX_ACCENT_MIX },
} as const;

export function isSupportedTileSize(value: number): value is SupportedTileSize {
  return SUPPORTED_TILE_SIZES.some((size) => size === value);
}

export function resolveTileSize(value: number | undefined): SupportedTileSize {
  return value !== undefined && isSupportedTileSize(value) ? value : DEFAULT_TILE_SIZE;
}
