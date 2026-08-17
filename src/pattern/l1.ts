/** B · F-02 L1 ProceduralEngine — 오프라인에서 즉시 생성되는 심리스 패턴. */
import type { FeatureSeed, PatternTile } from '../contracts.ts';
import {
  BACKGROUND_USER_COLOR_MIX,
  COGNAC,
  CREAM,
  DARK,
  DEFAULT_TILE_SIZE,
  MOTIF_EXTENT_FACTOR,
  resolveTileSize,
  type SupportedTileSize,
} from './constants.ts';
import { derivePatternGrammar, type PatternGrammar } from './grammar.ts';
import {
  guardPatternGrammar,
  createDiamondPalette,
  isPatternTileValid,
  mixHexColors,
  normalizeFeatureSeed,
  normalizeHexColor,
} from './guard.ts';
import {
  getAlignedPolygonVertices,
  getMotifCellCenter,
  getDiamondColorRole,
  getMotifRole,
  getUprightDiamondVertices,
  type MotifDetailVariant,
  type MotifKind,
  type MotifRole,
} from './motif.ts';
import { drawWrappedMotif } from './seamless.ts';

/** 기존 소비자 호환용 별칭. 새 코드는 DEFAULT_TILE_SIZE를 사용한다. */
export const TILE_SIZE = DEFAULT_TILE_SIZE;

export interface GenerateTileOptions {
  tileSize?: SupportedTileSize | number;
}

export interface ResolvedPatternColors {
  background: string;
  emblemBase: string;
  detailBase: string;
  accent: string;
  secondaryAccent: string;
  diamondPalette: ReturnType<typeof createDiamondPalette>;
}

export function mix(hexA: string, hexB: string, amount: number): string {
  return mixHexColors(
    normalizeHexColor(hexA, COGNAC),
    normalizeHexColor(hexB, COGNAC),
    amount,
  );
}

/** 렌더러와 로컬 QA가 같은 최종 색상·대비 보정 결과를 사용한다. */
export function resolvePatternColors(
  inputSeed: FeatureSeed,
  grammar: PatternGrammar,
): ResolvedPatternColors {
  const seed = normalizeFeatureSeed(inputSeed);
  const isDark = grammar.paletteMode === 'dark';
  const brandBackground = isDark ? mix(COGNAC, DARK, 0.18) : mix(COGNAC, CREAM, 0.08);
  const background = mix(
    brandBackground,
    seed.dominantColors[0],
    BACKGROUND_USER_COLOR_MIX,
  );
  const emblemBase = isDark ? CREAM : DARK;
  const detailBase = isDark ? COGNAC : CREAM;
  const accent = mix(emblemBase, seed.dominantColors[2], grammar.accentMix);
  const secondaryAccent = mix(emblemBase, seed.dominantColors[1], grammar.accentMix);
  return {
    background,
    emblemBase,
    detailBase,
    accent,
    secondaryAccent,
    diamondPalette: createDiamondPalette(
      seed.dominantColors,
      grammar.diamondColorMix,
      background,
    ),
  };
}

function drawMotifs(
  context: CanvasRenderingContext2D,
  tileSize: number,
  grammar: PatternGrammar,
  accent: string,
  secondaryAccent: string,
  emblemBase: string,
  detailBase: string,
  diamondPalette: ReturnType<typeof createDiamondPalette>,
): void {
  const cellCount = Math.round(tileSize / grammar.gridSpacing);

  const drawDiamond = (
    target: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
  ) => {
    const [top, right, bottom, left] = getUprightDiamondVertices(radius);
    target.moveTo(x + top!.x, y + top!.y);
    target.lineTo(x + right!.x, y + right!.y);
    target.lineTo(x + bottom!.x, y + bottom!.y);
    target.lineTo(x + left!.x, y + left!.y);
    target.closePath();
  };

  const drawClosedPolygon = (
    target: CanvasRenderingContext2D,
    vertices: readonly { x: number; y: number }[],
  ) => {
    vertices.forEach((vertex, index) => {
      if (index === 0) target.moveTo(vertex.x, vertex.y);
      else target.lineTo(vertex.x, vertex.y);
    });
    target.closePath();
  };

  const drawAbstractMotif = (
    point: { x: number; y: number },
    radius: number,
    motif: MotifKind,
    detailVariant: MotifDetailVariant,
    colors: { main: string; detail: string; center: string },
  ) => {
    context.save();
    context.translate(point.x, point.y);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(1, grammar.gridLineWidth * 0.58);

    if (motif === 'round-medallion') {
      context.strokeStyle = colors.main;
      context.beginPath();
      context.arc(0, 0, radius * 0.76, 0, Math.PI * 2);
      context.stroke();
      context.strokeStyle = colors.detail;
      context.beginPath();
      context.arc(0, 0, radius * (detailVariant >= 1 ? 0.48 : 0.38), 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = colors.center;
      context.beginPath();
      drawDiamond(context, 0, 0, radius * (detailVariant >= 2 ? 0.2 : 0.15));
      context.fill();
      if (detailVariant >= 1) {
        context.strokeStyle = colors.main;
        context.beginPath();
        context.arc(0, 0, radius * 0.61, Math.PI * 0.15, Math.PI * 0.85);
        context.stroke();
      }
    } else if (motif === 'faceted-shield') {
      const shield = [
        { x: 0, y: -radius * 0.84 },
        { x: radius * 0.64, y: -radius * 0.48 },
        { x: radius * 0.52, y: radius * 0.32 },
        { x: 0, y: radius * 0.86 },
        { x: -radius * 0.52, y: radius * 0.32 },
        { x: -radius * 0.64, y: -radius * 0.48 },
      ];
      context.strokeStyle = colors.main;
      context.beginPath();
      drawClosedPolygon(context, shield);
      context.stroke();
      context.strokeStyle = colors.detail;
      context.beginPath();
      context.moveTo(-radius * 0.43, -radius * 0.34);
      context.lineTo(0, radius * (detailVariant >= 1 ? 0.28 : 0.12));
      context.lineTo(radius * 0.43, -radius * 0.34);
      context.stroke();
      context.fillStyle = colors.center;
      context.beginPath();
      drawDiamond(context, 0, radius * 0.34, radius * (detailVariant >= 2 ? 0.18 : 0.13));
      context.fill();
    } else if (motif === 'ribbon-loop') {
      context.strokeStyle = colors.main;
      context.beginPath();
      context.moveTo(0, -radius * 0.18);
      context.bezierCurveTo(-radius * 0.28, -radius * 0.78, -radius * 0.86, -radius * 0.7, -radius * 0.82, 0);
      context.bezierCurveTo(-radius * 0.78, radius * 0.67, -radius * 0.26, radius * 0.64, 0, radius * 0.18);
      context.bezierCurveTo(radius * 0.26, radius * 0.64, radius * 0.78, radius * 0.67, radius * 0.82, 0);
      context.bezierCurveTo(radius * 0.86, -radius * 0.7, radius * 0.28, -radius * 0.78, 0, -radius * 0.18);
      context.closePath();
      context.stroke();
      context.strokeStyle = colors.detail;
      context.beginPath();
      context.arc(-radius * 0.37, 0, radius * (detailVariant >= 1 ? 0.22 : 0.15), 0, Math.PI * 2);
      context.arc(radius * 0.37, 0, radius * (detailVariant >= 1 ? 0.22 : 0.15), 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = colors.center;
      context.beginPath();
      context.arc(0, 0, radius * (detailVariant >= 2 ? 0.16 : 0.11), 0, Math.PI * 2);
      context.fill();
    } else if (motif === 'arched-gate') {
      context.strokeStyle = colors.main;
      context.beginPath();
      context.moveTo(-radius * 0.68, radius * 0.78);
      context.lineTo(-radius * 0.68, -radius * 0.08);
      context.bezierCurveTo(-radius * 0.68, -radius * 0.57, -radius * 0.36, -radius * 0.84, 0, -radius * 0.84);
      context.bezierCurveTo(radius * 0.36, -radius * 0.84, radius * 0.68, -radius * 0.57, radius * 0.68, -radius * 0.08);
      context.lineTo(radius * 0.68, radius * 0.78);
      context.closePath();
      context.stroke();
      context.strokeStyle = colors.detail;
      context.beginPath();
      context.moveTo(-radius * 0.4, radius * 0.58);
      context.lineTo(-radius * 0.4, -radius * 0.04);
      context.bezierCurveTo(-radius * 0.4, -radius * 0.34, -radius * 0.2, -radius * 0.52, 0, -radius * 0.52);
      context.bezierCurveTo(radius * 0.2, -radius * 0.52, radius * 0.4, -radius * 0.34, radius * 0.4, -radius * 0.04);
      context.lineTo(radius * 0.4, radius * 0.58);
      context.stroke();
      context.fillStyle = colors.center;
      context.beginPath();
      drawDiamond(context, 0, radius * 0.22, radius * (detailVariant >= 2 ? 0.18 : 0.13));
      context.fill();
    } else {
      const gem = [
        { x: 0, y: -radius * 0.86 },
        { x: radius * 0.58, y: -radius * 0.62 },
        { x: radius * 0.78, y: 0 },
        { x: radius * 0.48, y: radius * 0.72 },
        { x: 0, y: radius * 0.86 },
        { x: -radius * 0.48, y: radius * 0.72 },
        { x: -radius * 0.78, y: 0 },
        { x: -radius * 0.58, y: -radius * 0.62 },
      ];
      context.strokeStyle = colors.main;
      context.beginPath();
      drawClosedPolygon(context, gem);
      context.stroke();
      context.strokeStyle = colors.detail;
      context.beginPath();
      context.moveTo(0, -radius * 0.86);
      context.lineTo(-radius * 0.38, radius * 0.12);
      context.lineTo(0, radius * 0.86);
      context.moveTo(0, -radius * 0.86);
      context.lineTo(radius * 0.38, radius * 0.12);
      context.lineTo(0, radius * 0.86);
      context.stroke();
      if (detailVariant >= 1) {
        context.fillStyle = colors.center;
        context.beginPath();
        drawClosedPolygon(context, getAlignedPolygonVertices(detailVariant >= 2 ? 4 : 3, radius * 0.2));
        context.fill();
      }
    }
    context.restore();
  };

  const colorsFor = (role: MotifRole, column: number, row: number) => {
    if (grammar.accentPlacement === 'primary') {
      return { main: role === 'primary' ? accent : emblemBase, detail: detailBase, center: secondaryAccent };
    }
    if (grammar.accentPlacement === 'secondary') {
      return { main: role === 'secondary' ? secondaryAccent : emblemBase, detail: detailBase, center: secondaryAccent };
    }
    if (grammar.accentPlacement === 'motif-center') {
      return { main: emblemBase, detail: detailBase, center: role === 'primary' ? accent : secondaryAccent };
    }
    const alternating = (column + row + grammar.accentCellOffset) % grammar.motifFrequency === 0
      ? accent
      : emblemBase;
    return { main: alternating, detail: detailBase, center: secondaryAccent };
  };

  for (let column = 0; column < cellCount; column += 1) {
    for (let row = 0; row < cellCount; row += 1) {
      const role = getMotifRole(
        grammar.placementPattern,
        column,
        row,
      );
      if (!role) continue;
      const center = getMotifCellCenter(
        column,
        row,
        grammar.gridSpacing,
        grammar.motifPhase,
      );
      if (role === 'diamond') {
        const diamondRadius = grammar.diamondLongDiagonal / 2;
        const diamondColorRole = getDiamondColorRole(
          column,
          row,
          cellCount,
          grammar.diamondColorRatios,
          grammar.diamondColorPhase,
          grammar.diamondColorStride,
        );
        const diamondColor = diamondPalette[diamondColorRole];
        drawWrappedMotif(
          center.x,
          center.y,
          diamondRadius,
          tileSize,
          (point) => {
            context.save();
            context.translate(point.x, point.y);
            context.fillStyle = diamondColor;
            context.beginPath();
            drawDiamond(context, 0, 0, diamondRadius);
            context.fill();
            context.restore();
          },
        );
        continue;
      }
      const roleScale = role === 'primary' ? 1 : grammar.secondaryMotifScale;
      const radius = grammar.motifRadius * roleScale;
      const motif = role === 'primary' ? grammar.primaryMotif : grammar.secondaryMotif;
      drawWrappedMotif(center.x, center.y, radius * MOTIF_EXTENT_FACTOR, tileSize, (point) => {
        drawAbstractMotif(
          point,
          radius,
          motif,
          grammar.motifVariant,
          colorsFor(role, column, row),
        );
      });
    }
  }
}

function paintFallbackTile(canvas: HTMLCanvasElement): PatternTile['meta'] {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D 컨텍스트를 만들 수 없습니다');
  const size = canvas.width;
  context.fillStyle = COGNAC;
  context.fillRect(0, 0, size, size);
  const spacing = size / 8;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const x = (column + 0.5) * spacing;
      const y = (row + 0.5) * spacing;
      const diamondRadius = spacing * 0.12;
      drawWrappedMotif(x, y, diamondRadius, size, (point) => {
        context.fillStyle = (column + row) % 2 === 0 ? DARK : CREAM;
        context.beginPath();
        context.moveTo(point.x, point.y - diamondRadius);
        context.lineTo(point.x + diamondRadius, point.y);
        context.lineTo(point.x, point.y + diamondRadius);
        context.lineTo(point.x - diamondRadius, point.y);
        context.closePath();
        context.fill();
      });
    }
  }
  return { palette: [COGNAC, DARK, CREAM], spacing, motifDensity: 8, seedRef: COGNAC };
}

/** 타일 캔버스에 패턴을 그리고 계약 메타를 반환한다. */
export function paintTile(canvas: HTMLCanvasElement, inputSeed: FeatureSeed): PatternTile['meta'] {
  if (canvas.width !== canvas.height) throw new Error('패턴 타일은 정사각형이어야 합니다');
  const tileSize = resolveTileSize(canvas.width);
  if (tileSize !== canvas.width) throw new Error('지원하지 않는 패턴 타일 크기입니다');

  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D 컨텍스트를 만들 수 없습니다');

  const seed = normalizeFeatureSeed(inputSeed);
  const grammar = guardPatternGrammar(derivePatternGrammar(seed, tileSize), tileSize);
  const colors = resolvePatternColors(seed, grammar);

  context.fillStyle = colors.background;
  context.fillRect(0, 0, tileSize, tileSize);
  drawMotifs(
    context,
    tileSize,
    grammar,
    colors.accent,
    colors.secondaryAccent,
    colors.emblemBase,
    colors.detailBase,
    colors.diamondPalette,
  );

  return {
    palette: [
      colors.background,
      COGNAC,
      DARK,
      CREAM,
      colors.accent,
      colors.secondaryAccent,
      colors.diamondPalette.primary,
      colors.diamondPalette.secondary,
      colors.diamondPalette.accent,
    ],
    spacing: +grammar.gridSpacing.toFixed(2),
    motifDensity: +(tileSize / grammar.gridSpacing).toFixed(2),
    seedRef: seed.dominantColors[0],
  };
}

/** 기존 (seed, previewCanvas) 호출을 보존하며 선택적으로 512px 타일을 만든다. */
export async function generateTile(
  inputSeed: FeatureSeed,
  previewCanvas?: HTMLCanvasElement,
  options: GenerateTileOptions = {},
): Promise<PatternTile> {
  const tileSize = resolveTileSize(options.tileSize);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = tileSize;

  let meta: PatternTile['meta'];
  try {
    meta = paintTile(canvas, inputSeed);
  } catch (error) {
    console.warn('[pattern:L1] 문법 렌더 실패 — 안전한 기본 타일을 사용합니다', error);
    meta = paintFallbackTile(canvas);
  }

  const bitmap = await createImageBitmap(canvas);
  const tile: PatternTile = { bitmap, version: 'L1', meta };
  if (!isPatternTileValid(tile, tileSize, 'L1')) {
    bitmap.close();
    throw new Error('L1 PatternTile 검증에 실패했습니다');
  }

  if (previewCanvas) {
    const previewContext = previewCanvas.getContext('2d');
    if (previewContext) {
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewContext.drawImage(bitmap, 0, 0, previewCanvas.width, previewCanvas.height);
    }
  }

  return tile;
}
