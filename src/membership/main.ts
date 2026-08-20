import './style.css';
import type { FeatureSeed, PatternTile } from '../contracts.ts';
import { generateTile } from '../pattern/l1.ts';

/**
 * E · F-08 멤버십 패턴 시그니처 — 발표용 컨셉 화면.
 *
 * "재방문하면 내 패턴이 진화한다"는 서사를 위에서 아래로 읽히는 스크롤 내러티브로 보여준다.
 * 회차 그래픽은 그림이 아니라 F-02 L1 엔진 렌더 결과이며, 세 회차는 dominantColors·motionEnergy·rhythm이
 * 같고 sessionId만 다르다. F-02 문법에서 sessionId는 스타일 구간(minimal/rhythmic/dynamic)과
 * 팔레트 모드를 바꾸지 않고 모티프 실루엣·강조 배치·위상만 변주하므로, 같은 계보가
 * 자란 것처럼 읽힌다. 회차마다 붙는 "그대로/기준값" 칩은 문구가 아니라 렌더된 타일 메타를 비교해 만든다.
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
  /** 이번 회차에서 바뀐 축 — 문구는 F-02 문법상 sessionId가 실제로 흔드는 요소만 적는다. */
  marks: readonly string[];
}

const VISIT_STAGES: readonly VisitStage[] = [
  {
    label: '1회차',
    sessionId: `${MEMBER_ID}-visit1`,
    daysAgo: 172,
    change: '첫 체험. 관객색·모션·리듬에서 씨앗이 정해지고, 이 씨앗이 계정 시그니처로 저장됩니다. 이후 회차는 모두 여기서 갈라져 나옵니다.',
    marks: ['씨앗 확정', '팔레트 고정', '기준 회차'],
  },
  {
    label: '2회차',
    sessionId: `${MEMBER_ID}-visit2`,
    daysAgo: 96,
    change: '같은 씨앗, 새 sessionId. 주·보조 엠블럼의 실루엣이 교체되고 강조 모티프가 놓이는 자리가 바뀝니다. 팔레트와 스타일 구간은 그대로입니다.',
    marks: ['모티프 실루엣 교체', '강조 배치 이동'],
  },
  {
    label: '3회차',
    sessionId: `${MEMBER_ID}-visit3`,
    daysAgo: 24,
    change: '격자 위상과 마름모 색 주기까지 이동해, 같은 계보 안에서 기준 회차로부터 가장 멀리 온 변주가 됩니다.',
    marks: ['격자 위상 이동', '마름모 색 주기 이동'],
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
const signatureVisitValue = getElement<HTMLElement>('signatureVisitValue');
const signaturePalette = getElement<HTMLElement>('signaturePalette');
const stackCanvases = [
  getElement<HTMLCanvasElement>('stackCanvas1'),
  getElement<HTMLCanvasElement>('stackCanvas2'),
  getElement<HTMLCanvasElement>('stackCanvas3'),
];

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
  chips: HTMLElement;
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

function deltaChip(text: string, strong = false): HTMLElement {
  const chip = document.createElement('span');
  chip.className = strong ? 'deltaChip deltaChip--strong' : 'deltaChip';
  chip.textContent = text;
  return chip;
}

function createStageCard(stage: VisitStage, index: number, isCurrent: boolean): StageCard {
  const root = document.createElement('li');
  root.className = isCurrent ? 'stage stage--current' : 'stage';

  const rail = document.createElement('div');
  rail.className = 'stageRail';
  const number = document.createElement('p');
  number.className = 'stageNumber';
  number.textContent = String(index + 1).padStart(2, '0');
  number.setAttribute('aria-hidden', 'true');
  rail.append(number);

  const body = document.createElement('div');
  body.className = 'stageBody';

  const frame = document.createElement('div');
  frame.className = 'stageFrame';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PREVIEW_TILE_SIZE;
  frame.append(canvas);

  const text = document.createElement('div');
  text.className = 'stageText';

  const head = document.createElement('div');
  head.className = 'stageHead';
  const heading = document.createElement('h3');
  heading.textContent = isCurrent ? `${stage.label} · 현재` : stage.label;
  const visited = document.createElement('time');
  const visitedAt = visitDate(stage.daysAgo);
  visited.dateTime = visitedAt.toISOString().slice(0, 10);
  visited.textContent = dateFormat.format(visitedAt);
  head.append(heading, visited);

  const change = document.createElement('div');
  change.className = 'stageChange';
  const changeLabel = document.createElement('b');
  changeLabel.textContent = index === 0 ? 'What starts here' : 'What changed';
  const changeCopy = document.createElement('p');
  changeCopy.textContent = stage.change;
  change.append(changeLabel, changeCopy);

  const chips = document.createElement('div');
  chips.className = 'deltaChips';
  chips.append(...stage.marks.map((mark) => deltaChip(mark, index > 0)));

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

  text.append(head, change, chips, meta);
  body.append(frame, text);
  root.append(rail, body);
  return { root, canvas, chips, seedRef, density };
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
  signatureVisitValue.textContent = `${VISIT_STAGES.length}회`;
}

/**
 * "유지되는 축" 칩 — 문구가 아니라 렌더된 타일 메타에서 계산한다.
 * 세 회차의 밀도·간격·팔레트는 실제로 완전히 같고 seedRef만 다르다. 이 칩은 그 사실을
 * 화면에서 확인시켜 주는 자리이며, 값이 달라지면 문구도 자동으로 바뀐다.
 */
function invariantChip(current: PatternTile['meta'], previous: PatternTile['meta'] | undefined): HTMLElement {
  if (!previous) {
    return deltaChip(`기준값 · 밀도 ${current.motifDensity} · 간격 ${current.spacing}`);
  }

  const held = current.motifDensity === previous.motifDensity
    && current.spacing === previous.spacing
    && current.palette.join() === previous.palette.join();

  return deltaChip(held
    ? `그대로 · 밀도 ${current.motifDensity} · 팔레트 동일`
    : `밀도 ${previous.motifDensity} → ${current.motifDensity}`);
}

/** 화면 안으로 들어온 회차의 번호를 채운다. 기본 상태가 이미 보이는 상태라 관찰자가 없어도 안전하다. */
function observeStages(stages: readonly HTMLElement[]): void {
  if (typeof IntersectionObserver !== 'function') {
    for (const stage of stages) {
      stage.classList.add('is-revealed');
    }
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.2 });

  for (const stage of stages) {
    observer.observe(stage);
  }
}

async function renderEvolution(): Promise<void> {
  evolutionTrack.replaceChildren();

  const cards = VISIT_STAGES.map((stage, index) => {
    const card = createStageCard(stage, index, index === VISIT_STAGES.length - 1);
    evolutionTrack.append(card.root);
    return { card, index, stage };
  });

  // 세 회차를 동시에 렌더한다 — 히어로 스택이 카드보다 늦게 채워지는 빈 프레임이 생기지 않게.
  const tiles = await Promise.all(
    cards.map(({ card, stage }) => generateTile(seedForStage(stage), card.canvas, {
      tileSize: PREVIEW_TILE_SIZE,
    })),
  );

  tiles.forEach((tile: PatternTile, index: number) => {
    const { card } = cards[index]!;
    card.seedRef.textContent = tile.meta.seedRef;
    card.density.textContent = `${tile.meta.motifDensity} 셀 / 타일`;
    card.chips.append(invariantChip(tile.meta, tiles[index - 1]?.meta));

    stackCanvases[index]?.getContext('2d')?.drawImage(
      tile.bitmap,
      0,
      0,
      stackCanvases[index]!.width,
      stackCanvases[index]!.height,
    );
  });

  const currentTile = tiles[tiles.length - 1]!;
  signatureCanvas.getContext('2d')?.drawImage(
    currentTile.bitmap,
    0,
    0,
    signatureCanvas.width,
    signatureCanvas.height,
  );
  signatureSeedValue.textContent = currentTile.meta.seedRef;
  signatureDensityValue.textContent = `${currentTile.meta.motifDensity} 셀 / 타일`;
  signaturePalette.replaceChildren(...paletteSwatches(currentTile.meta.palette));

  observeStages(cards.map(({ card }) => card.root));
}

renderAccountCard();

renderEvolution()
  .then(() => {
    statusBand.textContent = '회차별 시그니처 3종을 패턴 엔진으로 렌더했습니다. 계정 연동·저장이 없는 발표용 컨셉 화면입니다.';
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : '시그니처를 렌더하지 못했습니다.';
    statusBand.textContent = `시그니처 렌더에 실패했습니다: ${detail}`;
  });
