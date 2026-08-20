import type { FeatureSeed, PatternTile } from '../contracts.ts';
import {
  BASE_TILE_SIZE,
  BRAND_PALETTE,
  DARK,
  DEFAULT_TILE_SIZE,
  DIAMOND_COLOR_CYCLE_LENGTH,
  DIAMOND_COLOR_RATIO_LIMITS,
  DIAMOND_LONG_DIAGONAL_RATIO,
  EMBLEM_VISUAL_SIZE_RATIO,
  EMBLEM_WIDTH_FACTOR,
  GRAMMAR_LIMITS,
  MAX_ACCENT_MIX,
  MIN_DIAMOND_BACKGROUND_LUMINANCE_DELTA,
  MIN_DIAMOND_LONG_DIAGONAL,
  MIN_EMBLEM_VISUAL_SIZE,
  type SupportedTileSize,
} from './constants.ts';
import type { PatternGrammar } from './grammar.ts';
import {
  ACCENT_PLACEMENTS,
  MOTIF_VARIANTS,
  PATTERN_STYLES,
  PLACEMENT_PATTERNS,
  getMaximumSafeMotifRadius,
} from './motif.ts';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_SESSION_ID = 'f02-fallback-session';

function clamp(value: number, min: number, max: number): number {
  const finite = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, finite));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function allowedValue<T>(value: T, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value) ? value : fallback;
}

export function normalizeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value.toUpperCase() : fallback;
}

/** 정책 없는 범용 색 혼합. 사용자색이 섞이는 경로에는 mixUserColor 를 쓴다. */
export function mixHexColors(hexA: string, hexB: string, amount: number): string {
  const colorA = normalizeHexColor(hexA, DARK);
  const colorB = normalizeHexColor(hexB, DARK);
  const ratio = clamp(amount, 0, 1);
  const channel = (color: string, index: number) => Number.parseInt(color.slice(index, index + 2), 16);
  const mixed = [1, 3, 5].map((index) => Math.round(
    channel(colorA, index) + (channel(colorB, index) - channel(colorA, index)) * ratio,
  ).toString(16).padStart(2, '0'));
  return `#${mixed.join('')}`.toUpperCase();
}

/**
 * 관객색(FeatureSeed.dominantColors)이 섞이는 유일한 통로. 브랜드 정체성 가드레일인
 * 35% 상한을 여기서 하드 클램프하므로, 사용자색은 반드시 이 함수를 거쳐야 한다.
 */
export function mixUserColor(brandHex: string, userHex: string, amount: number): string {
  return mixHexColors(brandHex, userHex, clamp(amount, 0, MAX_ACCENT_MIX));
}

export function colorLuminance(hex: string): number {
  const color = normalizeHexColor(hex, DARK);
  const channels = [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

export interface DiamondPalette {
  primary: string;
  secondary: string;
  accent: string;
  mixRatios: readonly [number, number, number];
}

/** 배경과 가까워지면 1%씩 DARK 쪽으로 되돌려 최소 명도 차이를 확보한다. */
export function createDiamondPalette(
  dominantColors: readonly string[],
  requestedMix: number,
  background: string,
): DiamondPalette {
  const safeMix = clamp(requestedMix, 0, MAX_ACCENT_MIX);
  const backgroundLuminance = colorLuminance(background);
  const mixOne = (input: unknown, fallback: string) => {
    const userColor = normalizeHexColor(input, fallback);
    for (let step = Math.round(safeMix * 100); step >= 0; step -= 1) {
      const amount = step / 100;
      const color = mixUserColor(DARK, userColor, amount);
      if (Math.abs(colorLuminance(color) - backgroundLuminance)
        >= MIN_DIAMOND_BACKGROUND_LUMINANCE_DELTA) {
        return { color, amount };
      }
    }
    // 0%까지 낮춰도 배경과 최소 명도차를 못 만드는 입력. 관객색을 버리고 DARK 로
    // 되돌리는 것이 유일한 안전 선택이지만, 조용히 넘기면 저대비 타일의 원인을
    // 추적할 수 없어 경고를 남긴다.
    console.warn(
      '[pattern:guard] 배경 대비를 확보하지 못해 관객색을 버리고 DARK로 대체합니다',
      { userColor: normalizeHexColor(input, fallback), background },
    );
    return { color: DARK, amount: 0 };
  };
  // 색상 역할: [0] 배경/보조 diamond, [1] 주 diamond, [2] 엠블럼/point diamond.
  const primary = mixOne(dominantColors[1], BRAND_PALETTE[1]);
  const secondary = mixOne(dominantColors[0], BRAND_PALETTE[0]);
  const accent = mixOne(dominantColors[2], BRAND_PALETTE[2]);
  return {
    primary: primary.color,
    secondary: secondary.color,
    accent: accent.color,
    mixRatios: [primary.amount, secondary.amount, accent.amount],
  };
}

/** 외부/목 입력이 계약을 어겨도 안전한 FeatureSeed로 복구한다. */
export function normalizeFeatureSeed(input: unknown): FeatureSeed {
  const record = isRecord(input) ? input : {};
  const rawColors = Array.isArray(record.dominantColors) ? record.dominantColors : [];
  const rawSessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';

  return {
    dominantColors: [
      normalizeHexColor(rawColors[0], BRAND_PALETTE[0]),
      normalizeHexColor(rawColors[1], BRAND_PALETTE[1]),
      normalizeHexColor(rawColors[2], BRAND_PALETTE[2]),
    ],
    motionEnergy: clamp(typeof record.motionEnergy === 'number' ? record.motionEnergy : 0, 0, 1),
    rhythm: clamp(typeof record.rhythm === 'number' ? record.rhythm : 0.5, 0, 1),
    sessionId: rawSessionId || FALLBACK_SESSION_ID,
  };
}

/** 문법값을 브랜드 허용 범위로 보정한다. */
export function guardPatternGrammar(
  grammar: PatternGrammar,
  tileSize: SupportedTileSize,
): PatternGrammar {
  const scale = tileSize / BASE_TILE_SIZE;
  const gridSpacing = clamp(
    grammar.gridSpacing,
    GRAMMAR_LIMITS.gridSpacing.min * scale,
    GRAMMAR_LIMITS.gridSpacing.max * scale,
  );
  const gridLineWidth = clamp(
    grammar.gridLineWidth,
    GRAMMAR_LIMITS.gridLineWidth.min * scale,
    GRAMMAR_LIMITS.gridLineWidth.max * scale,
  );
  const minimumDiamondLongDiagonal = Math.max(
    gridSpacing * DIAMOND_LONG_DIAGONAL_RATIO.min,
    MIN_DIAMOND_LONG_DIAGONAL * scale,
  );
  const requestedDiamondLongDiagonal = clamp(
    grammar.diamondLongDiagonal,
    minimumDiamondLongDiagonal,
    gridSpacing * DIAMOND_LONG_DIAGONAL_RATIO.max,
  );
  const maximumSafeRadius = Math.min(
    gridSpacing * EMBLEM_VISUAL_SIZE_RATIO.max / EMBLEM_WIDTH_FACTOR,
    getMaximumSafeMotifRadius(gridSpacing, scale, requestedDiamondLongDiagonal),
  );
  const minimumRadius = Math.min(
    Math.max(
      GRAMMAR_LIMITS.motifRadius.min * scale,
      gridSpacing * EMBLEM_VISUAL_SIZE_RATIO.min / EMBLEM_WIDTH_FACTOR,
      MIN_EMBLEM_VISUAL_SIZE * scale / EMBLEM_WIDTH_FACTOR,
    ),
    maximumSafeRadius,
  );
  const motifRadius = clamp(
    grammar.motifRadius,
    minimumRadius,
    Math.min(GRAMMAR_LIMITS.motifRadius.max * scale, maximumSafeRadius),
  );
  // 다이아몬드는 최소 22%를 보장하되 중심 엠블럼보다 커지지 않게 제한한다.
  const maximumDiamondLongDiagonal = Math.max(
    minimumDiamondLongDiagonal,
    Math.min(
      gridSpacing * DIAMOND_LONG_DIAGONAL_RATIO.max,
      motifRadius * EMBLEM_WIDTH_FACTOR * 0.84,
    ),
  );
  const diamondLongDiagonal = clamp(
    requestedDiamondLongDiagonal,
    minimumDiamondLongDiagonal,
    maximumDiamondLongDiagonal,
  );
  const primaryMotif = allowedValue(grammar.primaryMotif, MOTIF_VARIANTS, MOTIF_VARIANTS[0]);
  const requestedSecondary = allowedValue(grammar.secondaryMotif, MOTIF_VARIANTS, MOTIF_VARIANTS[1]);
  const secondaryMotif = requestedSecondary === primaryMotif
    ? MOTIF_VARIANTS[(MOTIF_VARIANTS.indexOf(primaryMotif) + 1) % MOTIF_VARIANTS.length]!
    : requestedSecondary;
  const diamondSecondaryRatio = clamp(
    grammar.diamondColorRatios?.secondary,
    DIAMOND_COLOR_RATIO_LIMITS.secondary.min,
    DIAMOND_COLOR_RATIO_LIMITS.secondary.max,
  );
  const diamondAccentRatio = clamp(
    grammar.diamondColorRatios?.accent,
    DIAMOND_COLOR_RATIO_LIMITS.accent.min,
    DIAMOND_COLOR_RATIO_LIMITS.accent.max,
  );
  const diamondPrimaryRatio = 1 - diamondSecondaryRatio - diamondAccentRatio;
  const diamondColorStrides = [3, 7, 9] as const;
  return {
    gridSpacing,
    gridLineWidth,
    motifRadius,
    motifFrequency: Math.round(
      clamp(
        grammar.motifFrequency,
        GRAMMAR_LIMITS.motifFrequency.min,
        GRAMMAR_LIMITS.motifFrequency.max,
      ),
    ),
    accentMix: clamp(
      grammar.accentMix,
      GRAMMAR_LIMITS.accentMix.min,
      GRAMMAR_LIMITS.accentMix.max,
    ),
    motifPhase: clamp(grammar.motifPhase, 0, 1),
    accentIndex: Math.round(clamp(grammar.accentIndex, 0, 2)),
    motifVariant: Math.round(clamp(grammar.motifVariant, 0, 2)) as PatternGrammar['motifVariant'],
    primaryMotif,
    secondaryMotif,
    placementPattern: allowedValue(
      grammar.placementPattern,
      PLACEMENT_PATTERNS,
      PLACEMENT_PATTERNS[0],
    ),
    accentPlacement: allowedValue(
      grammar.accentPlacement,
      ACCENT_PLACEMENTS,
      ACCENT_PLACEMENTS[0],
    ),
    style: allowedValue(grammar.style, PATTERN_STYLES, PATTERN_STYLES[1]),
    paletteMode: grammar.paletteMode === 'dark' ? 'dark' : 'cognac',
    secondaryMotifScale: clamp(grammar.secondaryMotifScale, 0.9, 1),
    accentCellOffset: Math.round(clamp(grammar.accentCellOffset, 0, 3)),
    diamondVariant: 'solid',
    diamondColorMix: clamp(grammar.diamondColorMix, 0, MAX_ACCENT_MIX),
    diamondColorRatios: {
      primary: clamp(
        diamondPrimaryRatio,
        DIAMOND_COLOR_RATIO_LIMITS.primary.min,
        DIAMOND_COLOR_RATIO_LIMITS.primary.max,
      ),
      secondary: diamondSecondaryRatio,
      accent: diamondAccentRatio,
    },
    diamondColorPhase: Math.round(clamp(
      grammar.diamondColorPhase,
      0,
      DIAMOND_COLOR_CYCLE_LENGTH - 1,
    )),
    diamondColorStride: allowedValue(
      grammar.diamondColorStride,
      diamondColorStrides,
      diamondColorStrides[0],
    ),
    diamondLongDiagonal,
  };
}

export function isPatternTileValid(
  tile: PatternTile | null | undefined,
  expectedSize: number = DEFAULT_TILE_SIZE,
  expectedVersion?: PatternTile['version'],
): tile is PatternTile {
  if (!tile || (expectedVersion !== undefined && tile.version !== expectedVersion)) return false;
  if (tile.bitmap.width !== expectedSize || tile.bitmap.height !== expectedSize) return false;
  if (!Array.isArray(tile.meta.palette) || tile.meta.palette.length === 0) return false;
  if (!tile.meta.palette.every((color) => HEX_COLOR.test(color))) return false;
  if (!Number.isFinite(tile.meta.spacing) || tile.meta.spacing <= 0) return false;
  if (!Number.isFinite(tile.meta.motifDensity) || tile.meta.motifDensity <= 0) return false;
  return typeof tile.meta.seedRef === 'string' && tile.meta.seedRef.length > 0;
}
