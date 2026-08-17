import type { FeatureSeed } from '../contracts.ts';
import {
  BASE_TILE_SIZE,
  DIAMOND_COLOR_CYCLE_LENGTH,
  DIAMOND_USER_COLOR_MIX,
  EMBLEM_USER_COLOR_MIX,
  MAX_ACCENT_MIX,
  type SupportedTileSize,
} from './constants.ts';
import {
  MOTIF_VARIANTS,
  getPatternStyle,
  resolveAccentPlacement,
  resolveMotifVariant,
  type AccentPlacement,
  type DiamondColorRatios,
  type DiamondVariant,
  type MotifDetailVariant,
  type MotifKind,
  type PatternStyle,
  type PlacementPattern,
} from './motif.ts';
import { createDeterministicRandom, hashString } from './random.ts';

export interface PatternGrammar {
  gridSpacing: number;
  gridAngleDeg: number;
  gridLineWidth: number;
  motifRadius: number;
  motifFrequency: number;
  accentMix: number;
  motifPhase: number;
  accentIndex: number;
  motifVariant: MotifDetailVariant;
  primaryMotif: MotifKind;
  secondaryMotif: MotifKind;
  placementPattern: PlacementPattern;
  accentPlacement: AccentPlacement;
  style: PatternStyle;
  paletteMode: 'cognac' | 'dark';
  secondaryMotifScale: number;
  accentCellOffset: number;
  diamondVariant: DiamondVariant;
  diamondColorMix: number;
  diamondColorRatios: DiamondColorRatios;
  diamondColorPhase: number;
  diamondColorStride: number;
  diamondLongDiagonal: number;
}

function colorLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

/** 정규화된 F-01 특징값을 비세토스 문법 파라미터로 결정적으로 변환한다. */
export function derivePatternGrammar(
  seed: FeatureSeed,
  tileSize: SupportedTileSize,
): PatternGrammar {
  // sessionId는 특징 구간이 정한 스타일을 뒤집지 않고 세부 조합·위상만 변주한다.
  const random = createDeterministicRandom(`${seed.sessionId}|pattern-identity`);
  const scale = tileSize / BASE_TILE_SIZE;
  const style = getPatternStyle(seed.motionEnergy);
  // 8/12/16은 4셀 heritage 배열 주기의 배수이며 타일 폭을 정확히 나눈다.
  const gridCount = style === 'minimal' ? 8 : style === 'rhythmic' ? 12 : 16;
  const gridSpacing = tileSize / gridCount;
  const emblemVisualSize = (style === 'minimal' ? 72 : style === 'rhythmic' ? 50 : 36) * scale;
  const diamondLongDiagonal = (style === 'minimal' ? 44 : style === 'rhythmic' ? 32 : 24) * scale;
  const primaryIndex = hashString(`${seed.sessionId}|primary-silhouette`) % MOTIF_VARIANTS.length;
  const secondaryOffset = 1
    + hashString(`${seed.sessionId}|secondary-silhouette`) % (MOTIF_VARIANTS.length - 1);
  const motifVariant = Math.min(2, Math.floor(seed.rhythm * 3)) as MotifDetailVariant;
  const placementPattern: PlacementPattern = seed.rhythm < 1 / 3
    ? 'heritage-sparse'
    : seed.rhythm < 2 / 3
      ? 'heritage-alternate'
      : 'heritage-rhythm';
  const colorPlacementIndex = hashString(`${seed.sessionId}|accent-placement`) + Math.floor(random() * 2);
  const diamondVariant: DiamondVariant = 'solid';
  const diamondSecondaryRatio = 0.15 + seed.rhythm * 0.10;
  const diamondAccentRatio = 0.05 + seed.rhythm * 0.05;
  const diamondColorStrides = [3, 7, 9] as const;

  return {
    gridSpacing,
    gridAngleDeg: 45,
    gridLineWidth: (2.5 + seed.rhythm * 3) * scale,
    // motion 단계가 실제 엠블럼 크기를 정하고 rhythm은 전체 크기를 바꾸지 않는다.
    motifRadius: emblemVisualSize / 1.76,
    // rhythm만 포인트 색상·주보조 교대 빈도를 조절하고 motion은 크기·개수에 한정한다.
    motifFrequency: Math.round(5 - seed.rhythm * 3),
    accentMix: Math.min(MAX_ACCENT_MIX, EMBLEM_USER_COLOR_MIX),
    motifPhase: Math.floor(random() * 2) * 0.5,
    accentIndex: 0,
    motifVariant,
    primaryMotif: resolveMotifVariant(primaryIndex),
    secondaryMotif: resolveMotifVariant(primaryIndex + secondaryOffset),
    placementPattern,
    accentPlacement: resolveAccentPlacement(colorPlacementIndex),
    style,
    paletteMode: colorLuminance(seed.dominantColors[0]) < 90 ? 'dark' : 'cognac',
    secondaryMotifScale: 1,
    accentCellOffset: Math.floor(random() * 4),
    diamondVariant,
    // 세 사용자색 모두 DARK에서 출발한다. 실제 비율은 배경 대비 Guard가 더 낮출 수 있다.
    diamondColorMix: Math.min(MAX_ACCENT_MIX, DIAMOND_USER_COLOR_MIX),
    diamondColorRatios: {
      primary: 1 - diamondSecondaryRatio - diamondAccentRatio,
      secondary: diamondSecondaryRatio,
      accent: diamondAccentRatio,
    },
    diamondColorPhase: hashString(`${seed.sessionId}|diamond-color-phase`)
      % DIAMOND_COLOR_CYCLE_LENGTH,
    diamondColorStride: diamondColorStrides[
      hashString(`${seed.sessionId}|diamond-color-stride`) % diamondColorStrides.length
    ]!,
    diamondLongDiagonal,
  };
}
