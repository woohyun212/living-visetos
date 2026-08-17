import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { FeatureSeed } from '../src/contracts.ts';
import {
  DARK,
  DIAMOND_COLOR_RATIO_LIMITS,
  DIAMOND_LONG_DIAGONAL_RATIO,
  DEFAULT_TILE_SIZE,
  EMBLEM_VISUAL_SIZE_RATIO,
  EMBLEM_WIDTH_FACTOR,
  GRAMMAR_LIMITS,
  MAX_ACCENT_MIX,
  MIN_CELL_BOUNDARY_MARGIN,
  MIN_DIAMOND_BACKGROUND_LUMINANCE_DELTA,
  MIN_DIAMOND_LONG_DIAGONAL,
  MIN_EMBLEM_VISUAL_SIZE,
  MIN_MOTIF_GRID_MARGIN,
  MIN_MOTIF_PAIR_MARGIN,
  resolveTileSize,
} from '../src/pattern/constants.ts';
import { derivePatternGrammar, type PatternGrammar } from '../src/pattern/grammar.ts';
import {
  colorLuminance,
  createDiamondPalette,
  guardPatternGrammar,
  isPatternTileValid,
  mixHexColors,
  normalizeFeatureSeed,
} from '../src/pattern/guard.ts';
import { generateTile, paintTile, resolvePatternColors, TILE_SIZE } from '../src/pattern/l1.ts';
import {
  DIAMOND_VARIANTS,
  EMBLEM_AXIS_ANGLE,
  getAlignedPolygonVertices,
  getCellBoundarySafetyMargin,
  getDiamondColorRole,
  getDiamondCell,
  getMotifCellCenter,
  getMotifGridSafetyMargin,
  getMotifPairSafetyMargin,
  getMotifRole,
  getUprightDiamondVertices,
  MOTIF_SILHOUETTES,
  MOTIF_VARIANTS,
  PLACEMENT_PATTERNS,
} from '../src/pattern/motif.ts';
import { createDeterministicRandom } from '../src/pattern/random.ts';
import { getWrappedPositions } from '../src/pattern/seamless.ts';

const seed: FeatureSeed = {
  dominantColors: ['#336699', '#AA7744', '#222222'],
  motionEnergy: 0.7,
  rhythm: 0.4,
  sessionId: 'session-a',
};

function recordPaintCommands(input: FeatureSeed, size: 512 | 1024 = 1024): string[] {
  const commands: string[] = [];
  const state = { fillStyle: '', strokeStyle: '', lineWidth: 0 };
  const context = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) { state.fillStyle = String(value); },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(value: string | CanvasGradient | CanvasPattern) { state.strokeStyle = String(value); },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(value: number) { state.lineWidth = value; },
    lineCap: 'butt',
    lineJoin: 'miter',
    fillRect: (...values: number[]) => commands.push(`fillRect:${state.fillStyle}:${values.join(',')}`),
    beginPath: () => commands.push('begin'),
    closePath: () => commands.push('close'),
    moveTo: (...values: number[]) => commands.push(`move:${values.join(',')}`),
    lineTo: (...values: number[]) => commands.push(`line:${values.join(',')}`),
    stroke: () => commands.push(`stroke:${state.strokeStyle}:${state.lineWidth}`),
    fill: () => commands.push(`fill:${state.fillStyle}`),
    arc: (...values: number[]) => commands.push(`arc:${values.join(',')}`),
    bezierCurveTo: (...values: number[]) => commands.push(`bezier:${values.join(',')}`),
    save: () => commands.push('save'),
    restore: () => commands.push('restore'),
    translate: (...values: number[]) => commands.push(`translate:${values.join(',')}`),
    rotate: (value: number) => commands.push(`rotate:${value}`),
  } as unknown as CanvasRenderingContext2D;
  const canvas = { width: size, height: size, getContext: () => context } as unknown as HTMLCanvasElement;
  paintTile(canvas, input);
  return commands;
}

test('FeatureSeed 범위, 비정상 숫자, 색상과 빈 세션을 정규화한다', () => {
  const normalized = normalizeFeatureSeed({
    dominantColors: ['invalid', '#abcdef'],
    motionEnergy: Infinity,
    rhythm: -3,
    sessionId: '   ',
  });
  assert.deepEqual(normalized.dominantColors, ['#A9652C', '#ABCDEF', '#F2E7D2']);
  assert.equal(normalized.motionEnergy, 0);
  assert.equal(normalized.rhythm, 0);
  assert.ok(normalized.sessionId.length > 0);

  const upper = normalizeFeatureSeed({ motionEnergy: 2, rhythm: Number.NaN });
  assert.equal(upper.motionEnergy, 1);
  assert.equal(upper.rhythm, 0);
});

test('문법값은 허용 범위와 accent 35% 상한 안에 있다', () => {
  const unsafe: PatternGrammar = {
    gridSpacing: Infinity,
    gridAngleDeg: 10,
    gridLineWidth: 100,
    motifRadius: -10,
    motifFrequency: 99,
    accentMix: 1,
    motifPhase: -1,
    accentIndex: 9,
    motifVariant: 99,
    primaryMotif: 'twin-diamond',
    secondaryMotif: 'twin-diamond',
    placementPattern: 'checkerboard',
    accentPlacement: 'alternating-cells',
    style: 'dynamic',
    paletteMode: 'cognac',
    secondaryMotifScale: 99,
    accentCellOffset: 99,
    diamondVariant: 'unknown-diamond',
    diamondColorMix: 1,
    diamondColorRatios: { primary: -1, secondary: 1, accent: 1 },
    diamondColorPhase: 99,
    diamondColorStride: 100,
    diamondLongDiagonal: Infinity,
  };
  const guarded = guardPatternGrammar(unsafe, 1024);
  assert.equal(guarded.gridAngleDeg, 45);
  assert.ok(guarded.gridSpacing >= GRAMMAR_LIMITS.gridSpacing.min);
  assert.ok(guarded.gridSpacing <= GRAMMAR_LIMITS.gridSpacing.max);
  assert.ok(guarded.accentMix <= MAX_ACCENT_MIX);
  assert.ok(guarded.motifFrequency >= 2 && guarded.motifFrequency <= 5);
  assert.ok(guarded.motifVariant >= 0 && guarded.motifVariant < MOTIF_VARIANTS.length);
  assert.notEqual(guarded.primaryMotif, guarded.secondaryMotif);
  assert.ok(guarded.secondaryMotifScale >= 0.9 && guarded.secondaryMotifScale <= 1);
  assert.ok(guarded.accentCellOffset >= 0 && guarded.accentCellOffset <= 3);
  assert.equal(guarded.diamondVariant, 'solid');
  assert.ok(guarded.diamondColorMix <= MAX_ACCENT_MIX);
  assert.ok(guarded.diamondColorRatios.primary >= DIAMOND_COLOR_RATIO_LIMITS.primary.min);
  assert.ok(guarded.diamondColorRatios.primary <= DIAMOND_COLOR_RATIO_LIMITS.primary.max);
  assert.ok(guarded.diamondColorRatios.secondary >= DIAMOND_COLOR_RATIO_LIMITS.secondary.min);
  assert.ok(guarded.diamondColorRatios.secondary <= DIAMOND_COLOR_RATIO_LIMITS.secondary.max);
  assert.ok(guarded.diamondColorRatios.accent >= DIAMOND_COLOR_RATIO_LIMITS.accent.min);
  assert.ok(guarded.diamondColorRatios.accent <= DIAMOND_COLOR_RATIO_LIMITS.accent.max);
  assert.ok(Math.abs(
    guarded.diamondColorRatios.primary
      + guarded.diamondColorRatios.secondary
      + guarded.diamondColorRatios.accent - 1,
  ) < 1e-9);
  assert.ok(guarded.diamondLongDiagonal / guarded.gridSpacing <= DIAMOND_LONG_DIAGONAL_RATIO.max);
});

test('같은 시드는 같은 문법과 랜덤을, 다른 세션은 다른 변주를 만든다', () => {
  assert.deepEqual(derivePatternGrammar(seed, 1024), derivePatternGrammar(seed, 1024));
  assert.notDeepEqual(
    derivePatternGrammar(seed, 1024),
    derivePatternGrammar({ ...seed, sessionId: 'session-b' }, 1024),
  );
  const first = createDeterministicRandom('same-key');
  const second = createDeterministicRandom('same-key');
  assert.deepEqual([first(), first(), first()], [second(), second(), second()]);
});

test('512와 1024는 같은 상대 문법 비율을 유지한다', () => {
  const small = derivePatternGrammar(seed, 512);
  const large = derivePatternGrammar(seed, 1024);
  assert.equal(small.gridSpacing * 2, large.gridSpacing);
  assert.equal(small.gridLineWidth * 2, large.gridLineWidth);
  assert.equal(small.motifRadius * 2, large.motifRadius);
  assert.equal(small.diamondLongDiagonal * 2, large.diamondLongDiagonal);
  assert.equal(resolveTileSize(999), DEFAULT_TILE_SIZE);
});

test('움직임·리듬 low/medium/high가 크기·배치·복잡도를 주도하고 연속값도 유지한다', () => {
  const low = derivePatternGrammar({ ...seed, motionEnergy: 0, rhythm: 0 }, 1024);
  const medium = derivePatternGrammar({ ...seed, motionEnergy: 0.5, rhythm: 0.5 }, 1024);
  const high = derivePatternGrammar({ ...seed, motionEnergy: 1, rhythm: 1 }, 1024);
  assert.deepEqual([low.style, medium.style, high.style], ['minimal', 'rhythmic', 'dynamic']);
  assert.deepEqual(
    [low.placementPattern, medium.placementPattern, high.placementPattern],
    ['heritage-sparse', 'heritage-alternate', 'heritage-rhythm'],
  );
  assert.ok(high.gridSpacing < low.gridSpacing);
  assert.ok(high.motifFrequency < low.motifFrequency);
  assert.ok(high.gridLineWidth > low.gridLineWidth);
  assert.ok(low.motifRadius > medium.motifRadius && medium.motifRadius > high.motifRadius);
  assert.ok(low.diamondLongDiagonal > medium.diamondLongDiagonal);
  assert.ok(medium.diamondLongDiagonal > high.diamondLongDiagonal);
  assert.equal(low.motifVariant, 0);
  assert.equal(high.motifVariant, 2);
});

test('rhythm과 sessionId가 달라도 다이아몬드는 solid이며 색상 교대 비율·위치만 바뀐다', () => {
  const low = derivePatternGrammar({ ...seed, rhythm: 0, sessionId: 'color-low' }, 1024);
  const medium = derivePatternGrammar({ ...seed, rhythm: 0.5, sessionId: 'color-low' }, 1024);
  const high = derivePatternGrammar({ ...seed, rhythm: 1, sessionId: 'color-low' }, 1024);
  assert.deepEqual(DIAMOND_VARIANTS, ['solid']);
  assert.ok([low, medium, high].every((grammar) => grammar.diamondVariant === 'solid'));
  assert.ok(low.diamondColorRatios.primary > medium.diamondColorRatios.primary);
  assert.ok(medium.diamondColorRatios.primary > high.diamondColorRatios.primary);
  assert.ok(low.diamondColorRatios.secondary < medium.diamondColorRatios.secondary);
  assert.ok(medium.diamondColorRatios.secondary < high.diamondColorRatios.secondary);
  assert.ok(low.diamondColorRatios.accent < high.diamondColorRatios.accent);
  assert.ok(high.diamondColorRatios.primary > high.diamondColorRatios.secondary);

  const rolesFor = (grammar: PatternGrammar) => Array.from({ length: 20 }, (_, ordinal) =>
    getDiamondColorRole(
      ordinal * 2 + 1,
      0,
      40,
      grammar.diamondColorRatios,
      grammar.diamondColorPhase,
      grammar.diamondColorStride,
    ));
  const lowRoles = rolesFor(low);
  const highRoles = rolesFor(high);
  assert.deepEqual(
    ['primary', 'secondary', 'accent'].map((role) => lowRoles.filter((value) => value === role).length),
    [16, 3, 1],
  );
  assert.deepEqual(
    ['primary', 'secondary', 'accent'].map((role) => highRoles.filter((value) => value === role).length),
    [13, 5, 2],
  );
  assert.ok(lowRoles.filter((role) => role !== 'primary').length
    < highRoles.filter((role) => role !== 'primary').length);
  assert.deepEqual(rolesFor(low), rolesFor(derivePatternGrammar({ ...seed, rhythm: 0, sessionId: 'color-low' }, 1024)));
  assert.notDeepEqual(
    rolesFor(low),
    rolesFor(derivePatternGrammar({ ...seed, rhythm: 0, sessionId: 'color-other' }, 1024)),
  );
});

test('sessionId는 같은 특징 구간의 세부 변주만 바꾸고 스타일 계열을 뒤집지 않는다', () => {
  const first = derivePatternGrammar({ ...seed, sessionId: 'tie-a' }, 1024);
  const second = derivePatternGrammar({ ...seed, sessionId: 'tie-b' }, 1024);
  assert.equal(first.style, second.style);
  assert.equal(first.placementPattern, second.placementPattern);
  assert.equal(first.gridSpacing, second.gridSpacing);
  assert.equal(first.gridLineWidth, second.gridLineWidth);
  assert.notDeepEqual(
    [first.primaryMotif, first.secondaryMotif, first.motifPhase, first.accentCellOffset],
    [second.primaryMotif, second.secondaryMotif, second.motifPhase, second.accentCellOffset],
  );
});

test('모든 heritage 배열은 빈 anchor 없이 엠블럼과 다이아몬드를 교대한다', () => {
  for (const placement of PLACEMENT_PATTERNS) {
    for (let row = 0; row < 16; row += 1) {
      const roles = Array.from({ length: 16 }, (_, column) => getMotifRole(placement, column, row));
      assert.ok(roles.every((role) => role === 'primary' || role === 'secondary' || role === 'diamond'));
      assert.equal(roles.filter((role) => role === 'primary' || role === 'secondary').length, 8);
      assert.equal(roles.filter((role) => role === 'diamond').length, 8);
    }
  }
});

test('motion 단계는 8/12/16셀과 72/50/36px 엠블럼, 44/32/24px 다이아몬드를 만든다', () => {
  const cases = [
    { motionEnergy: 0.1, cells: 8, spacing: 128, emblem: 72, diamond: 44 },
    { motionEnergy: 0.5, cells: 12, spacing: 1024 / 12, emblem: 50, diamond: 32 },
    { motionEnergy: 0.9, cells: 16, spacing: 64, emblem: 36, diamond: 24 },
  ] as const;
  const sizes = cases.map(({ motionEnergy, cells, spacing, emblem, diamond }) => {
    const grammar = guardPatternGrammar(
      derivePatternGrammar({ ...seed, motionEnergy, rhythm: 0.5 }, 1024),
      1024,
    );
    const actualEmblem = grammar.motifRadius * EMBLEM_WIDTH_FACTOR;
    assert.equal(Math.round(1024 / grammar.gridSpacing), cells);
    assert.ok(Math.abs(grammar.gridSpacing - spacing) < 1e-9);
    assert.ok(Math.abs(actualEmblem - emblem) < 1e-9);
    assert.ok(Math.abs(grammar.diamondLongDiagonal - diamond) < 1e-9);
    assert.ok(actualEmblem / grammar.gridSpacing >= EMBLEM_VISUAL_SIZE_RATIO.min);
    assert.ok(actualEmblem / grammar.gridSpacing <= EMBLEM_VISUAL_SIZE_RATIO.max);
    assert.ok(grammar.diamondLongDiagonal / grammar.gridSpacing >= DIAMOND_LONG_DIAGONAL_RATIO.min);
    assert.ok(grammar.diamondLongDiagonal / grammar.gridSpacing <= DIAMOND_LONG_DIAGONAL_RATIO.max);
    assert.ok(actualEmblem / grammar.diamondLongDiagonal >= 1.5);
    assert.ok(actualEmblem / grammar.diamondLongDiagonal <= 1.7);
    assert.ok(actualEmblem >= MIN_EMBLEM_VISUAL_SIZE);
    assert.ok(grammar.diamondLongDiagonal >= MIN_DIAMOND_LONG_DIAGONAL);
    return { actualEmblem, diamond: grammar.diamondLongDiagonal, cells };
  });
  assert.ok(sizes[0]!.actualEmblem > sizes[1]!.actualEmblem);
  assert.ok(sizes[1]!.actualEmblem > sizes[2]!.actualEmblem);
  assert.ok(sizes[0]!.diamond > sizes[1]!.diamond);
  assert.ok(sizes[1]!.diamond > sizes[2]!.diamond);
  assert.ok(sizes[0]!.cells < sizes[1]!.cells && sizes[1]!.cells < sizes[2]!.cells);
});

test('모든 스타일에 독립 다이아몬드가 존재하고 중심 엠블럼과 교대한다', () => {
  const styles = [
    derivePatternGrammar({ ...seed, motionEnergy: 0 }, 1024),
    derivePatternGrammar({ ...seed, motionEnergy: 0.5 }, 1024),
    derivePatternGrammar({ ...seed, motionEnergy: 1 }, 1024),
  ];
  for (const grammar of styles) {
    const roles = Array.from(
      { length: 16 },
      (_, column) => getMotifRole(grammar.placementPattern, column, 0),
    );
    assert.ok(roles.includes('diamond'));
    for (let index = 1; index < roles.length; index += 1) {
      if (roles[index] === 'diamond') {
        assert.notEqual(roles[index - 1], 'diamond');
      }
    }
  }
  assert.deepEqual(
    Array.from({ length: 4 }, (_, column) => getMotifRole('heritage-alternate', column, 0)),
    ['primary', 'diamond', 'secondary', 'diamond'],
  );
  assert.deepEqual(
    Array.from({ length: 4 }, (_, column) => getMotifRole('heritage-alternate', column, 1)),
    ['diamond', 'secondary', 'diamond', 'primary'],
  );
});

test('다이아몬드·중심 엠블럼 크기가 셀 비율 Guard 안에 있다', () => {
  for (const size of [512, 1024] as const) {
    for (const motionEnergy of [0, 0.5, 1]) {
      for (const rhythm of [0, 0.5, 1]) {
        const grammar = guardPatternGrammar(
          derivePatternGrammar({ ...seed, motionEnergy, rhythm }, size),
          size,
        );
        const diamondRatio = grammar.diamondLongDiagonal / grammar.gridSpacing;
        const emblemRatio = grammar.motifRadius * EMBLEM_WIDTH_FACTOR / grammar.gridSpacing;
        assert.ok(diamondRatio >= DIAMOND_LONG_DIAGONAL_RATIO.min - 1e-9);
        assert.ok(diamondRatio <= DIAMOND_LONG_DIAGONAL_RATIO.max + 1e-9);
        assert.ok(emblemRatio >= EMBLEM_VISUAL_SIZE_RATIO.min - 1e-9);
        assert.ok(emblemRatio <= EMBLEM_VISUAL_SIZE_RATIO.max + 1e-9);
      }
    }
  }
});

test('중심 엠블럼·다이아몬드·셀 경계는 최소 안전 여백을 유지한다', () => {
  for (const size of [512, 1024] as const) {
    const scale = size / 1024;
    for (const motionEnergy of [0, 0.5, 1]) {
      const grammar = guardPatternGrammar(
        derivePatternGrammar({ ...seed, motionEnergy }, size),
        size,
      );
      assert.ok(getMotifPairSafetyMargin(
        grammar.gridSpacing,
        grammar.motifRadius,
        grammar.diamondLongDiagonal,
      ) >= MIN_MOTIF_PAIR_MARGIN * scale - 1e-9);
      assert.ok(getCellBoundarySafetyMargin(
        grammar.gridSpacing,
        grammar.motifRadius,
        grammar.diamondLongDiagonal,
      ) >= MIN_CELL_BOUNDARY_MARGIN * scale - 1e-9);
    }
  }
});

test('모든 배치 규칙은 8/12/16셀 타일 경계를 넘어 같은 주기로 반복된다', () => {
  for (const cellCount of [8, 12, 16]) {
    for (const placement of PLACEMENT_PATTERNS) {
      for (let row = 0; row < cellCount; row += 1) {
        for (let column = 0; column < cellCount; column += 1) {
          assert.equal(
            getMotifRole(placement, column, row),
            getMotifRole(placement, column + cellCount, row + cellCount),
          );
        }
      }
    }
  }
});

test('동일 입력·시드는 같은 렌더 명령을, 다른 시드는 다른 픽셀 입력을 만든다', () => {
  const first = recordPaintCommands(seed);
  const second = recordPaintCommands(seed);
  const different = recordPaintCommands({ ...seed, sessionId: 'session-other' });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, different);
});

test('dominantColors 세 색은 각각 배경·주 모티프·보조 다이아몬드 픽셀에 반영된다', () => {
  const zeroMotionSeed = { ...seed, motionEnergy: 0, rhythm: 0 };
  const base = recordPaintCommands(zeroMotionSeed);
  const color0 = recordPaintCommands({
    ...zeroMotionSeed,
    dominantColors: ['#55AA77', seed.dominantColors[1], seed.dominantColors[2]],
  });
  const color1 = recordPaintCommands({
    ...zeroMotionSeed,
    dominantColors: [seed.dominantColors[0], '#22AAEE', seed.dominantColors[2]],
  });
  const color2 = recordPaintCommands({
    ...zeroMotionSeed,
    dominantColors: [seed.dominantColors[0], seed.dominantColors[1], '#EE44AA'],
  });
  assert.notDeepEqual(base, color0);
  assert.notDeepEqual(base, color1);
  assert.notDeepEqual(base, color2);
});

test('1024px L1 Canvas 렌더 명령 생성은 1초 미만이다', () => {
  const started = performance.now();
  const commands = recordPaintCommands(seed, 1024);
  const duration = performance.now() - started;
  assert.ok(commands.length > 0);
  assert.ok(duration < 1000, `렌더 명령 생성 ${duration.toFixed(2)}ms`);
});

test('generateTile 기본 출력은 정확히 1024×1024 PatternTile이다', async () => {
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    fillRect: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    arc: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    drawImage: () => undefined,
  } as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async (source: HTMLCanvasElement) => ({
      width: source.width,
      height: source.height,
      close: () => undefined,
    }),
  });
  try {
    const tile = await generateTile(seed);
    assert.equal(TILE_SIZE, 1024);
    assert.equal(tile.bitmap.width, 1024);
    assert.equal(tile.bitmap.height, 1024);
    assert.equal(tile.version, 'L1');
    assert.equal(isPatternTileValid(tile, 1024, 'L1'), true);
  } finally {
    if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    if (originalCreateImageBitmap === undefined) {
      delete (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
    } else {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      });
    }
  }
});

test('모서리 모티프는 반대편 세 모서리까지 복제한다', () => {
  const points = getWrappedPositions(2, 2, 5, 512);
  assert.deepEqual(points, [
    { x: 2, y: 2 },
    { x: 2, y: 514 },
    { x: 514, y: 2 },
    { x: 514, y: 514 },
  ]);
});

test('모티프 중심은 stagger 없이 같은 행과 열에 직교 정렬된다', () => {
  const grammar = guardPatternGrammar(derivePatternGrammar(seed, 1024), 1024);
  const spacing = grammar.gridSpacing;
  const phaseOffset = grammar.motifPhase * spacing;
  for (let column = 4; column < 7; column += 1) {
    for (let row = 4; row < 6; row += 1) {
      const center = getMotifCellCenter(column, row, spacing, grammar.motifPhase);
      const cell = getDiamondCell(center, spacing);
      const diagonalCenter = {
        x: (cell.left.x + cell.right.x) / 2,
        y: (cell.top.y + cell.bottom.y) / 2,
      };
      assert.ok(Math.abs(center.x - diagonalCenter.x) < 1e-9);
      assert.ok(Math.abs(center.y - diagonalCenter.y) < 1e-9);
    }
  }

  const first = getMotifCellCenter(0, 0, spacing, grammar.motifPhase);
  assert.equal(first.x, phaseOffset + spacing / 2);
  assert.equal(first.y, phaseOffset + spacing / 2);

  for (let column = 0; column < 4; column += 1) {
    const columnCenters = Array.from({ length: 4 }, (_, row) =>
      getMotifCellCenter(column, row, spacing, grammar.motifPhase));
    assert.ok(columnCenters.every((center) => center.x === columnCenters[0]!.x));
  }
  for (let row = 0; row < 4; row += 1) {
    const rowCenters = Array.from({ length: 4 }, (_, column) =>
      getMotifCellCenter(column, row, spacing, grammar.motifPhase));
    assert.ok(rowCenters.every((center) => center.y === rowCenters[0]!.y));
  }

  const evenRow = getMotifCellCenter(2, 0, spacing, grammar.motifPhase);
  const oddRow = getMotifCellCenter(2, 1, spacing, grammar.motifPhase);
  assert.equal(oddRow.x, evenRow.x);
  assert.equal(getMotifCellCenter(3, 0, spacing, grammar.motifPhase).x - evenRow.x, spacing);
  assert.equal(oddRow.y - evenRow.y, spacing);
});

test('공통 phase는 전체 직교 격자를 x·y로 같은 만큼 평행 이동한다', () => {
  const spacing = 64;
  const base = getMotifCellCenter(3, 5, spacing, 0);
  const shifted = getMotifCellCenter(3, 5, spacing, 0.25);
  assert.equal(shifted.x - base.x, spacing * 0.25);
  assert.equal(shifted.y - base.y, spacing * 0.25);
});

test('모티프 종류만 row+column 체커보드로 교대하고 anchor를 비우지 않는다', () => {
  for (const placement of PLACEMENT_PATTERNS) {
    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < 6; column += 1) {
        const role = getMotifRole(placement, column, row);
        if ((row + column) % 2 === 0) {
          assert.ok(role === 'primary' || role === 'secondary');
        } else {
          assert.equal(role, 'diamond');
        }
      }
    }
  }
});

test('렌더러와 안전 폴백에는 stagger나 엠블럼 내·외부 임의 회전이 없다', () => {
  const source = readFileSync(new URL('../src/pattern/l1.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\(row\s*%\s*2\)[^\n]*spacing\s*\/\s*2/);
  assert.doesNotMatch(source, /rotatePoint|rotationRad|getMotifRotation|context\.rotate/);
});

test('모든 내부 다각형은 sessionId와 rhythm에 무관하게 외곽과 같은 수직 기준축을 사용한다', () => {
  assert.equal(EMBLEM_AXIS_ANGLE, -Math.PI / 2);
  for (const sides of [5, 6, 8]) {
    const vertices = getAlignedPolygonVertices(sides, 20);
    assert.ok(Math.abs(vertices[0]!.x) < 1e-12);
    assert.equal(vertices[0]!.y, -20);
  }
  for (const sessionId of ['axis-a', 'axis-b']) {
    for (const rhythm of [0, 0.5, 1]) {
      const grammar = derivePatternGrammar({ ...seed, sessionId, rhythm }, 1024);
      assert.ok(grammar.motifVariant >= 0 && grammar.motifVariant <= 2);
      assert.equal('motifRotationRad' in grammar, false);
      assert.equal('rotationPattern' in grammar, false);
    }
  }
});

test('모티프 외곽은 512와 1024 모두 인접 모티프 최소 여백을 유지한다', () => {
  for (const size of [512, 1024] as const) {
    for (const rhythm of [0, 0.5, 1]) {
      const grammar = guardPatternGrammar(
        derivePatternGrammar({ ...seed, rhythm, sessionId: `safety-${size}-${rhythm}` }, size),
        size,
      );
      const margin = getMotifGridSafetyMargin(
        grammar.gridSpacing,
        grammar.gridLineWidth,
        grammar.motifRadius,
      );
      assert.ok(margin >= MIN_MOTIF_GRID_MARGIN * (size / 1024) - 1e-9);
    }
  }
});

test('모든 내부 모티프 변형은 같은 Guard 반경 안에서 중앙·안전 여백을 유지한다', () => {
  for (const motifVariant of [0, 1, 2] as const) {
    for (const size of [512, 1024] as const) {
      const grammar = guardPatternGrammar(
        { ...derivePatternGrammar(seed, size), motifVariant },
        size,
      );
      const center = getMotifCellCenter(3, 4, grammar.gridSpacing, grammar.motifPhase);
      const cell = getDiamondCell(center, grammar.gridSpacing);
      assert.deepEqual(cell.center, center);
      assert.ok(getMotifGridSafetyMargin(
        grammar.gridSpacing,
        grammar.gridLineWidth,
        grammar.motifRadius,
      ) >= MIN_MOTIF_GRID_MARGIN * (size / 1024) - 1e-9);
    }
  }
});

test('주·보조 중심 엠블럼과 포인트 세부 규칙은 세션별로 결정적이다', () => {
  assert.deepEqual(MOTIF_VARIANTS, [
    'round-medallion',
    'faceted-shield',
    'ribbon-loop',
    'arched-gate',
    'gem-medallion',
  ]);
  assert.equal(new Set(Object.values(MOTIF_SILHOUETTES)).size, MOTIF_VARIANTS.length);
  assert.ok(!MOTIF_VARIANTS.some((motif) => motif === ('signal-emblem' as string)));
  const grammars = Array.from({ length: 30 }, (_, index) =>
    derivePatternGrammar({ ...seed, sessionId: `variant-${index}` }, 1024));
  grammars.forEach((grammar, index) => {
    assert.deepEqual(grammar, derivePatternGrammar({ ...seed, sessionId: `variant-${index}` }, 1024));
    assert.notEqual(grammar.primaryMotif, grammar.secondaryMotif);
  });
  assert.ok(new Set(grammars.map((grammar) => `${grammar.primaryMotif}/${grammar.secondaryMotif}`)).size >= 8);
  assert.ok(new Set(grammars.flatMap((grammar) => [
    MOTIF_SILHOUETTES[grammar.primaryMotif],
    MOTIF_SILHOUETTES[grammar.secondaryMotif],
  ])).size >= 4);
  assert.equal(new Set(grammars.map((grammar) => grammar.placementPattern)).size, 1);
  assert.ok(new Set(grammars.map((grammar) => grammar.accentCellOffset)).size > 1);
  assert.ok(grammars.every((grammar) => grammar.diamondVariant === 'solid'));
  assert.ok(new Set(grammars.map((grammar) =>
    `${grammar.diamondColorPhase}/${grammar.diamondColorStride}`)).size > 1);
  assert.ok(grammars.every((grammar) => grammar.accentIndex === 0));
});

test('QA 대표 세션 8개는 같은 특징값에서 서로 다른 외곽 조합과 5개 계열을 만든다', () => {
  const sessionIds = [
    'qa-emblem-1', 'qa-emblem-2', 'qa-emblem-3', 'qa-emblem-4',
    'qa-emblem-5', 'qa-emblem-7', 'qa-emblem-8', 'qa-emblem-9',
  ];
  const grammars = sessionIds.map((sessionId) =>
    derivePatternGrammar({ ...seed, motionEnergy: 0.5, rhythm: 0.5, sessionId }, 1024));
  assert.equal(new Set(grammars.map(({ primaryMotif, secondaryMotif }) =>
    `${primaryMotif}/${secondaryMotif}`)).size, 8);
  assert.equal(new Set(grammars.flatMap(({ primaryMotif, secondaryMotif }) => [
    MOTIF_SILHOUETTES[primaryMotif],
    MOTIF_SILHOUETTES[secondaryMotif],
  ])).size, 5);
  assert.ok(grammars.every(({ primaryMotif, secondaryMotif }) => primaryMotif !== secondaryMotif));
});

test('독립 다이아몬드는 모든 입력에서 정방향 외곽과 최소 가시 크기를 유지한다', () => {
  assert.deepEqual(getUprightDiamondVertices(12), [
    { x: 0, y: -12 },
    { x: 12, y: 0 },
    { x: 0, y: 12 },
    { x: -12, y: 0 },
  ]);
  for (const motionEnergy of [0, 0.5, 1]) {
    for (const rhythm of [0, 0.5, 1]) {
      const grammar = guardPatternGrammar(derivePatternGrammar({
        ...seed,
        motionEnergy,
        rhythm,
        sessionId: `upright-${motionEnergy}-${rhythm}`,
      }, 1024), 1024);
      assert.ok(grammar.diamondLongDiagonal / grammar.gridSpacing >= DIAMOND_LONG_DIAGONAL_RATIO.min - 1e-9);
      assert.ok(grammar.diamondLongDiagonal / grammar.gridSpacing <= DIAMOND_LONG_DIAGONAL_RATIO.max + 1e-9);
      assert.equal(grammar.diamondVariant, 'solid');
      assert.ok(Array.from({ length: 6 }, (_, index) =>
        getMotifRole(grammar.placementPattern, index, 0)).includes('diamond'));
    }
  }
});

test('L1 렌더러는 문자나 외부 패턴 이미지를 삽입하지 않는다', () => {
  const source = [
    'constants.ts', 'grammar.ts', 'guard.ts', 'motif.ts', 'random.ts', 'seamless.ts', 'l1.ts',
  ].map((file) => readFileSync(new URL(`../src/pattern/${file}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(source, /drawDiamondGrid/);
  assert.doesNotMatch(source, /signal-emblem/);
  assert.doesNotMatch(source, /fillText|strokeText/);
  assert.doesNotMatch(source, /https?:\/\/|fetch\s*\(/);
  assert.doesNotMatch(source, /['"`]MCM['"`]/);
  assert.doesNotMatch(source, /Math\.random\s*\(/);
});

test('세 dominantColors는 DARK와 최대 35% 혼합되고 배경 최소 대비를 유지한다', () => {
  const grammar = guardPatternGrammar(derivePatternGrammar(seed, 1024), 1024);
  const background = '#B9824F';
  const palette = createDiamondPalette(seed.dominantColors, grammar.diamondColorMix, background);
  assert.equal(grammar.diamondVariant, 'solid');
  assert.ok(grammar.diamondColorMix <= MAX_ACCENT_MIX);
  assert.deepEqual(
    [palette.primary, palette.secondary, palette.accent],
    [seed.dominantColors[1], seed.dominantColors[0], seed.dominantColors[2]]
      .map((color, index) => mixHexColors(DARK, color, palette.mixRatios[index]!)),
  );
  assert.ok(palette.mixRatios.every((ratio) => ratio <= MAX_ACCENT_MIX));
  assert.ok([palette.primary, palette.secondary, palette.accent].every((color) =>
    Math.abs(colorLuminance(color) - colorLuminance(background))
      >= MIN_DIAMOND_BACKGROUND_LUMINANCE_DELTA));

  for (const colors of [
    ['#FFFFFF', '#FFFEEE', '#FFFF00'],
    ['#000000', '#050505', '#101010'],
    ['#A9652C', '#A9652C', '#A9652C'],
  ]) {
    const extreme = createDiamondPalette(colors, MAX_ACCENT_MIX, background);
    assert.ok(extreme.mixRatios.every((ratio) => ratio <= MAX_ACCENT_MIX));
    assert.ok([extreme.primary, extreme.secondary, extreme.accent].every((color) =>
      Math.abs(colorLuminance(color) - colorLuminance(background))
        >= MIN_DIAMOND_BACKGROUND_LUMINANCE_DELTA));
  }
});

test('motionEnergy 0과 1은 색상 문법을 약화시키지 않고 크기·밀도만 바꾼다', () => {
  const stillSeed = { ...seed, motionEnergy: 0, rhythm: 0 };
  const activeSeed = { ...seed, motionEnergy: 1, rhythm: 0 };
  const stillGrammar = guardPatternGrammar(derivePatternGrammar(stillSeed, 1024), 1024);
  const activeGrammar = guardPatternGrammar(derivePatternGrammar(activeSeed, 1024), 1024);
  assert.equal(stillGrammar.accentMix, activeGrammar.accentMix);
  assert.equal(stillGrammar.diamondColorMix, activeGrammar.diamondColorMix);
  assert.deepEqual(stillGrammar.diamondColorRatios, activeGrammar.diamondColorRatios);
  assert.equal(stillGrammar.motifFrequency, activeGrammar.motifFrequency);
  assert.equal(stillGrammar.placementPattern, activeGrammar.placementPattern);
  assert.deepEqual(
    resolvePatternColors(stillSeed, stillGrammar),
    resolvePatternColors(activeSeed, activeGrammar),
  );
  assert.ok(stillGrammar.gridSpacing > activeGrammar.gridSpacing);
  assert.ok(stillGrammar.motifRadius > activeGrammar.motifRadius);
});

test('기본 렌더 명령에는 화면을 가로지르는 연결선이 없고 독립 도형만 있다', () => {
  const commands = recordPaintCommands(seed);
  const lineCoordinates = commands
    .filter((command) => command.startsWith('move:') || command.startsWith('line:'))
    .flatMap((command) => command.slice(command.indexOf(':') + 1).split(',').map(Number));
  assert.ok(lineCoordinates.length > 0);
  assert.ok(lineCoordinates.every((value) => Math.abs(value) < 100));
  const source = readFileSync(new URL('../src/pattern/l1.ts', import.meta.url), 'utf8');
  assert.match(source, /role === 'diamond'/);
  assert.doesNotMatch(source, /diamondVariant ===/);
  assert.doesNotMatch(source, /inset|split|double/);
  assert.doesNotMatch(source, /context\.stroke\(\);\s*\n\s*if \(grammar\.diamond/);
  assert.match(source, /drawWrappedMotif/);
});

test('PatternTile 공개 계약과 F-03·F-04 동일 객체 전달 연결을 유지한다', () => {
  const fakeTile = {
    bitmap: { width: 1024, height: 1024, close: () => undefined } as ImageBitmap,
    version: 'L1',
    meta: { palette: ['#A9652C', '#3A2A18', '#F2E7D2'], spacing: 64, motifDensity: 16, seedRef: '#336699' },
  } as const;
  assert.equal(isPatternTileValid(fakeTile, 1024, 'L1'), true);
  const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /overlay\.setTile\(tile\)/);
  assert.match(mainSource, /bag\?\.applyTile\(tile\)/);
});
