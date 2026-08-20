import './style.css';
import type { FeatureSeed } from '../contracts.ts';
import { generateTile } from '../pattern/l1.ts';

/**
 * E · F-08 멤버십 패턴 시그니처 — 발표용 컨셉 화면.
 *
 * "재방문하면 내 패턴이 진화한다"는 서사를 정적 화면으로 보여준다. 회차 그래픽은
 * 그림이 아니라 F-02 L1 엔진 렌더 결과이며, 세 회차는 dominantColors·motionEnergy·rhythm이
 * 같고 sessionId만 다르다. F-02 문법에서 sessionId는 스타일 구간(minimal/rhythmic/dynamic)과
 * 팔레트 모드를 바꾸지 않고 모티프 실루엣·강조 배치·위상만 변주하므로, 같은 계보가
 * 자란 것처럼 읽힌다.
 *
 * 계정 연동·로그인·저장은 데모 스코프 밖이다(기획서 §7 Out). 이 화면에 저장 동작은 없다.
 */

const MEMBER_ID = 'LV-MB-4821';

/** 회차마다 달라지는 것은 sessionId 하나뿐이다. */
const SIGNATURE_SEED: Omit<FeatureSeed, 'sessionId'> = {
  dominantColors: ['#B8875A', '#EFE3CE', '#5C4630'],
  motionEnergy: 0.52,
  rhythm: 0.58,
};

interface VisitStage {
  label: string;
  sessionId: string;
  /** 방문일은 컨셉 화면이 언제 시연되어도 "최근 이력"으로 읽히도록 로드 시각 기준 과거 오프셋으로 잡는다. */
  daysAgo: number;
  change: string;
}

const VISIT_STAGES: readonly VisitStage[] = [
  {
    label: '1회차',
    sessionId: `${MEMBER_ID}-visit1`,
    daysAgo: 172,
    change: '첫 체험. 씨앗이 정해지고 시그니처가 계정에 저장됩니다.',
  },
  {
    label: '2회차',
    sessionId: `${MEMBER_ID}-visit2`,
    daysAgo: 96,
    change: '같은 씨앗, 새 sessionId. 주·보조 엠블럼 실루엣과 강조 배치가 바뀝니다.',
  },
  {
    label: '3회차',
    sessionId: `${MEMBER_ID}-visit3`,
    daysAgo: 24,
    change: '격자 위상과 마름모 색 주기까지 이동해, 같은 계보 안에서 가장 멀리 온 변주가 됩니다.',
  },
];

const PREVIEW_TILE_SIZE = 512;

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing membership element: ${id}`);
  }
  return element as T;
};

const statusBand = getElement<HTMLElement>('statusBand');
const evolutionTrack = getElement<HTMLElement>('evolutionTrack');
const signatureCanvas = getElement<HTMLCanvasElement>('signatureCanvas');
const memberIdValue = getElement<HTMLElement>('memberIdValue');
const memberSinceValue = getElement<HTMLElement>('memberSinceValue');
const visitCountValue = getElement<HTMLElement>('visitCountValue');
const signatureSeedValue = getElement<HTMLElement>('signatureSeedValue');
const signatureDensityValue = getElement<HTMLElement>('signatureDensityValue');
const signaturePalette = getElement<HTMLElement>('signaturePalette');

const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long' });

function visitDate(daysAgo: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(0, 0, 0, 0);
  return date;
}

function seedForStage(stage: VisitStage): FeatureSeed {
  return { ...SIGNATURE_SEED, sessionId: stage.sessionId };
}

interface StageCard {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  seedRef: HTMLElement;
  density: HTMLElement;
}

function metaCell(label: string, value: Node): HTMLElement {
  const cell = document.createElement('div');
  const caption = document.createElement('span');
  caption.textContent = label;
  cell.append(caption, value);
  return cell;
}

function createStageCard(stage: VisitStage, isCurrent: boolean): StageCard {
  const root = document.createElement('article');
  root.className = isCurrent ? 'stageCard stageCard--current' : 'stageCard';

  const head = document.createElement('div');
  head.className = 'stageHead';
  const heading = document.createElement('h3');
  heading.textContent = stage.label;
  const visited = document.createElement('span');
  visited.textContent = dateFormat.format(visitDate(stage.daysAgo));
  head.append(heading, visited);

  const frame = document.createElement('div');
  frame.className = 'stageFrame';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PREVIEW_TILE_SIZE;
  frame.append(canvas);

  const change = document.createElement('span');
  change.textContent = stage.change;

  const sessionId = document.createElement('b');
  sessionId.textContent = stage.sessionId;
  const seedRef = document.createElement('b');
  seedRef.textContent = '렌더 중';
  const density = document.createElement('b');
  density.textContent = '렌더 중';

  const meta = document.createElement('div');
  meta.className = 'stageMeta';
  meta.append(
    metaCell('sessionId', sessionId),
    metaCell('seedRef', seedRef),
    metaCell('모티프 밀도', density),
  );

  root.append(head, frame, change, meta);
  return { root, canvas, seedRef, density };
}

function stageArrow(): HTMLElement {
  const arrow = document.createElement('span');
  arrow.className = 'stageArrow';
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');
  return arrow;
}

function paletteSwatches(palette: readonly string[]): HTMLElement[] {
  return palette.slice(0, 5).map((color) => {
    const swatch = document.createElement('i');
    swatch.style.background = color;
    swatch.title = color;
    return swatch;
  });
}

function renderAccountCard(): void {
  const firstStage = VISIT_STAGES[0]!;
  memberIdValue.textContent = MEMBER_ID;
  memberSinceValue.textContent = dateFormat.format(visitDate(firstStage.daysAgo));
  visitCountValue.textContent = `${VISIT_STAGES.length}회`;
}

async function renderEvolution(): Promise<void> {
  evolutionTrack.replaceChildren();

  for (const [index, stage] of VISIT_STAGES.entries()) {
    if (index > 0) {
      evolutionTrack.append(stageArrow());
    }

    const isCurrent = index === VISIT_STAGES.length - 1;
    const card = createStageCard(stage, isCurrent);
    evolutionTrack.append(card.root);

    const tile = await generateTile(seedForStage(stage), card.canvas, {
      tileSize: PREVIEW_TILE_SIZE,
    });
    card.seedRef.textContent = tile.meta.seedRef;
    card.density.textContent = `${tile.meta.motifDensity} 셀 / 타일`;

    if (isCurrent) {
      const context = signatureCanvas.getContext('2d');
      context?.drawImage(tile.bitmap, 0, 0, signatureCanvas.width, signatureCanvas.height);
      signatureSeedValue.textContent = tile.meta.seedRef;
      signatureDensityValue.textContent = `${tile.meta.motifDensity} 셀 / 타일`;
      signaturePalette.replaceChildren(...paletteSwatches(tile.meta.palette));
    }
  }
}

renderAccountCard();

renderEvolution()
  .then(() => {
    statusBand.textContent = '회차별 시그니처 3종을 F-02 L1 엔진으로 렌더했습니다. 계정 연동·저장이 없는 발표용 컨셉 화면입니다.';
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : '시그니처를 렌더하지 못했습니다.';
    statusBand.textContent = `시그니처 렌더에 실패했습니다: ${detail}`;
  });
