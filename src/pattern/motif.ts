import {
  DIAMOND_COLOR_CYCLE_LENGTH,
  MIN_CELL_BOUNDARY_MARGIN,
  MIN_MOTIF_PAIR_MARGIN,
  MIN_MOTIF_SPACING_MARGIN,
  MOTIF_EXTENT_FACTOR,
} from './constants.ts';
import type { Point } from './seamless.ts';

/** 문자·공식 로고가 아닌 Canvas 기본 도형만으로 만든 My Visetos 자체 심볼. */
export const MOTIF_VARIANTS = [
  'round-medallion',
  'faceted-shield',
  'ribbon-loop',
  'arched-gate',
  'gem-medallion',
] as const;
export type MotifKind = (typeof MOTIF_VARIANTS)[number];
/** 기존 내부 import 호환용 별칭. */
export type MotifVariant = MotifKind;

/** QA와 테스트가 이름이 아닌 실제 외곽 계열의 차이를 확인하는 명시적 분류. */
export const MOTIF_SILHOUETTES: Readonly<Record<MotifKind, string>> = {
  'round-medallion': 'round',
  'faceted-shield': 'shield',
  'ribbon-loop': 'twin-loop',
  'arched-gate': 'arch',
  'gem-medallion': 'faceted-gem',
};

export const PLACEMENT_PATTERNS = [
  'heritage-alternate',
  'heritage-sparse',
  'heritage-rhythm',
] as const;
export type PlacementPattern = (typeof PLACEMENT_PATTERNS)[number];

export const ACCENT_PLACEMENTS = [
  'primary',
  'secondary',
  'motif-center',
  'alternating-cells',
] as const;
export type AccentPlacement = (typeof ACCENT_PLACEMENTS)[number];

export const PATTERN_STYLES = ['minimal', 'rhythmic', 'dynamic'] as const;
export type PatternStyle = (typeof PATTERN_STYLES)[number];
export type MotifDetailVariant = 0 | 1 | 2;
export type MotifRole = 'primary' | 'secondary' | 'diamond';

/** 다이아몬드 외곽·채움은 공통 정체성이므로 내부 변형 없이 solid 하나만 허용한다. */
export const DIAMOND_VARIANTS = ['solid'] as const;
export type DiamondVariant = (typeof DIAMOND_VARIANTS)[number];
export const DIAMOND_COLOR_ROLES = ['primary', 'secondary', 'accent'] as const;
export type DiamondColorRole = (typeof DIAMOND_COLOR_ROLES)[number];
export interface DiamondColorRatios {
  primary: number;
  secondary: number;
  accent: number;
}

export interface DiamondCell {
  center: Point;
  top: Point;
  right: Point;
  bottom: Point;
  left: Point;
}

/** 모든 엠블럼 외곽·내부 다각형이 공유하는 수직 기준축(첫 꼭짓점은 위쪽). */
export const EMBLEM_AXIS_ANGLE = -Math.PI / 2;

export function getAlignedPolygonVertices(sides: number, radius: number): readonly Point[] {
  const safeSides = Math.max(3, Math.round(Number.isFinite(sides) ? sides : 3));
  const safeRadius = Math.max(0, Number.isFinite(radius) ? radius : 0);
  return Array.from({ length: safeSides }, (_, index) => {
    const angle = EMBLEM_AXIS_ANGLE + index * Math.PI * 2 / safeSides;
    return { x: Math.cos(angle) * safeRadius, y: Math.sin(angle) * safeRadius };
  });
}

/**
 * 독립 다이아몬드의 공통 불변 외곽. 세션·리듬과 무관하게 꼭짓점은
 * 정확히 위·오른쪽·아래·왼쪽을 향하며 렌더러에서 회전하지 않는다.
 */
export function getUprightDiamondVertices(radius: number): readonly Point[] {
  const safeRadius = Math.max(0, Number.isFinite(radius) ? radius : 0);
  return [
    { x: 0, y: -safeRadius },
    { x: safeRadius, y: 0 },
    { x: 0, y: safeRadius },
    { x: -safeRadius, y: 0 },
  ] as const;
}

export function resolveMotifVariant(index: number): MotifKind {
  const safeIndex = Number.isFinite(index) ? Math.round(index) : 0;
  return MOTIF_VARIANTS[((safeIndex % MOTIF_VARIANTS.length) + MOTIF_VARIANTS.length) % MOTIF_VARIANTS.length]!;
}

export function resolvePlacementPattern(index: number): PlacementPattern {
  return resolveListValue(PLACEMENT_PATTERNS, index);
}

export function resolveAccentPlacement(index: number): AccentPlacement {
  return resolveListValue(ACCENT_PLACEMENTS, index);
}

function resolveListValue<T>(values: readonly T[], index: number): T {
  const safeIndex = Number.isFinite(index) ? Math.floor(index) : 0;
  return values[((safeIndex % values.length) + values.length) % values.length]!;
}

/**
 * 셀 좌표만으로 반복되는 배치 규칙. 셀마다 난수를 사용하지 않는다.
 *
 * 격자 자체를 45° 회전시키던 v0 스켈레톤과 달리, 여기서는 격자를 직교로 두고
 * 다이아몬드를 '모티프 형태'로 배치한다. 기술적 제약이 아니라, 스켈레톤 가드레일의
 * 두 조항("다이아 격자 리듬 고정"과 "문자·로고 없음")을 동시에 지키기 위한 설계다.
 *
 * 원 패턴의 정체성은 로고와 다이아몬드가 교대하는 리듬에 있는데, 그 리듬을 각도까지
 * 그대로 따라가면 로고 자리를 무엇으로 채우든 브랜드 마크를 직접 재현하는 쪽으로
 * 기운다. 대회 브리핑이 브랜드 직접 노출을 금지하므로, 지켜야 할 것은 각도가 아니라
 * '규칙적인 다이아몬드 + 교대'라고 보고 로고 자리를 자체 추상 엠블럼(MOTIF_VARIANTS)
 * 으로 대체했다. 헤리티지는 리듬으로 남기고 브랜드 마크는 드러내지 않는다.
 *
 * 따라서 격자 각도는 더 이상 문법 파라미터가 아니며 `gridAngleDeg`는 제거되었다.
 */
export function getMotifRole(
  pattern: PlacementPattern,
  column: number,
  row: number,
): MotifRole | null {
  // 모든 위치는 직교 체커보드이며 홀수 셀은 공통 solid 다이아몬드다.
  if (positiveModulo(column + row, 2) === 1) return 'diamond';
  // 엠블럼 셀만 rhythm 문법에 따라 주·보조 외곽을 교대하며 빈 anchor는 만들지 않는다.
  if (pattern === 'heritage-sparse') {
    return positiveModulo(column, 4) === 2 && positiveModulo(row, 4) === 0
      ? 'secondary'
      : 'primary';
  }
  if (pattern === 'heritage-alternate') {
    return positiveModulo(column + row, 4) === 0 ? 'primary' : 'secondary';
  }
  return positiveModulo(column, 4) === 0 && positiveModulo(row, 4) === 0
    ? 'primary'
    : 'secondary';
}

export function getPatternStyle(motionEnergy: number): PatternStyle {
  if (motionEnergy < 1 / 3) return 'minimal';
  if (motionEnergy < 2 / 3) return 'rhythmic';
  return 'dynamic';
}

export function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}

/** 행·열 stagger 없이 공통 phase만 평행 이동에 사용하는 직교 anchor 중심. */
export function getMotifCellCenter(
  column: number,
  row: number,
  spacing: number,
  phase: number,
): Point {
  const globalPhase = phase * spacing;
  return {
    x: globalPhase + (column + 0.5) * spacing,
    y: globalPhase + (row + 0.5) * spacing,
  };
}

/**
 * 체커보드의 다이아몬드 anchor를 20칸 주기에 고르게 분산한다.
 * phase/stride만 세션에서 오므로 색 위치는 달라져도 외곽·정렬은 바뀌지 않는다.
 */
export function getDiamondColorRole(
  column: number,
  row: number,
  cellCount: number,
  ratios: DiamondColorRatios,
  phase: number,
  stride: number,
): DiamondColorRole {
  const diamondsPerRow = Math.max(1, Math.ceil(cellCount / 2));
  const ordinal = row * diamondsPerRow + Math.floor(column / 2);
  const cycleLength = DIAMOND_COLOR_CYCLE_LENGTH;
  const cycleIndex = positiveModulo(ordinal * stride + phase, cycleLength);
  const primaryCount = Math.round(ratios.primary * cycleLength);
  const secondaryCount = Math.round(ratios.secondary * cycleLength);
  if (cycleIndex < primaryCount) return 'primary';
  if (cycleIndex < primaryCount + secondaryCount) return 'secondary';
  return 'accent';
}

export function getDiamondCell(center: Point, spacing: number): DiamondCell {
  const halfDiagonal = spacing / 2;
  return {
    center,
    top: { x: center.x, y: center.y - halfDiagonal },
    right: { x: center.x + halfDiagonal, y: center.y },
    bottom: { x: center.x, y: center.y + halfDiagonal },
    left: { x: center.x - halfDiagonal, y: center.y },
  };
}

/** 인접한 독립 모티프의 보수적인 외곽 사이 최소 거리. */
export function getMotifSpacingSafetyMargin(
  spacing: number,
  motifRadius: number,
): number {
  return spacing - motifRadius * MOTIF_EXTENT_FACTOR * 2;
}

/** 서로 이웃한 중심 엠블럼과 독립 다이아몬드 외곽 사이 거리. */
export function getMotifPairSafetyMargin(
  spacing: number,
  motifRadius: number,
  diamondLongDiagonal: number,
): number {
  return spacing - motifRadius * MOTIF_EXTENT_FACTOR - diamondLongDiagonal / 2;
}

/** 보이지 않는 셀 경계와 가장 큰 모티프 외곽 사이 거리. */
export function getCellBoundarySafetyMargin(
  spacing: number,
  motifRadius: number,
  diamondLongDiagonal: number,
): number {
  return spacing / 2 - Math.max(
    motifRadius * MOTIF_EXTENT_FACTOR,
    diamondLongDiagonal / 2,
  );
}

/** 기존 로컬 QA 호환용. gridLineWidth는 더 이상 연결 격자 여백에 사용하지 않는다. */
export function getMotifGridSafetyMargin(
  spacing: number,
  _gridLineWidth: number,
  motifRadius: number,
): number {
  return getMotifSpacingSafetyMargin(spacing, motifRadius);
}

/** 인접 모티프가 붙지 않도록 최소 여백을 확보할 수 있는 최대 중심 엠블럼 반지름. */
export function getMaximumSafeMotifRadius(
  spacing: number,
  scale: number,
  diamondLongDiagonal = 0,
): number {
  const sameRoleLimit = (spacing - MIN_MOTIF_SPACING_MARGIN * scale)
    / (MOTIF_EXTENT_FACTOR * 2);
  const pairLimit = (spacing - MIN_MOTIF_PAIR_MARGIN * scale - diamondLongDiagonal / 2)
    / MOTIF_EXTENT_FACTOR;
  const cellLimit = (spacing / 2 - MIN_CELL_BOUNDARY_MARGIN * scale)
    / MOTIF_EXTENT_FACTOR;
  return Math.max(
    0,
    Math.min(sameRoleLimit, pairLimit, cellLimit),
  );
}
