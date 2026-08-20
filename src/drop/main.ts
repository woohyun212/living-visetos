import './style.css';
import type { FeatureSeed } from '../contracts.ts';
import { generateTile } from '../pattern/l1.ts';

/**
 * E · F-07 한정판 드랍 페이지 — 발표용 목업.
 *
 * 시즌 패턴은 이미지 자산이 아니라 키오스크와 같은 F-02 L1 엔진(generateTile)에
 * 고정 FeatureSeed를 넣어 렌더한 결과다. L1은 결정론이라 언제 열어도 같은 패턴이 나오고,
 * 그래서 "시즌 패턴"이라는 서사와 엔진 시연이 한 화면에서 동시에 성립한다.
 *
 * 응모 폼은 목업이다 — 백엔드가 없고, 제출은 안내 문구만 띄운다.
 */

interface SeasonDrop {
  id: string;
  name: string;
  story: string;
  quantity: number;
  seed: FeatureSeed;
}

/**
 * motionEnergy는 style(minimal/rhythmic/dynamic) 구간을, rhythm은 배치·디테일 단계를,
 * dominantColors[0]의 명도는 팔레트 모드를 가른다. 세 시즌이 서로 다른 구간에 놓이도록 골랐다.
 */
const SEASON_DROPS: readonly SeasonDrop[] = [
  {
    id: 'aurum',
    name: 'AURUM · 오럼',
    story: '느린 호흡의 관객에게서 나온 최소 밀도 문법. 큰 엠블럼과 넓은 여백이 코냑 톤 위에 놓인다.',
    quantity: 100,
    seed: {
      dominantColors: ['#D8C39B', '#F1E7D4', '#9A6A34'],
      motionEnergy: 0.18,
      rhythm: 0.16,
      sessionId: 'drop-2026ss-aurum',
    },
  },
  {
    id: 'verdant',
    name: 'VERDANT · 베르당',
    story: '중간 리듬 구간의 교대 배치. 엠블럼과 마름모가 같은 비중으로 번갈아 나타난다.',
    quantity: 100,
    seed: {
      dominantColors: ['#7E9C86', '#E4EDE3', '#2F4A38'],
      motionEnergy: 0.50,
      rhythm: 0.52,
      sessionId: 'drop-2026ss-verdant',
    },
  },
  {
    id: 'noctis',
    name: 'NOCTIS · 녹티스',
    story: '가장 빠른 모션 구간에서 태어난 고밀도 문법. 어두운 관객색이 팔레트를 다크 모드로 뒤집는다.',
    quantity: 100,
    seed: {
      dominantColors: ['#232B36', '#8FA3BC', '#C9D6E6'],
      motionEnergy: 0.86,
      rhythm: 0.88,
      sessionId: 'drop-2026ss-noctis',
    },
  },
];

const PREVIEW_TILE_SIZE = 512;
const BANNER_TILE_SIZE = 160;
/** 목업이 언제 시연되어도 D-day가 살아 있도록 마감을 고정 날짜가 아닌 로드 시각 기준 오프셋으로 잡는다. */
const ENTRY_DEADLINE_DAYS = 12;
const ENTRY_DEADLINE_HOUR = 20;

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing drop element: ${id}`);
  }
  return element as T;
};

const statusBand = getElement<HTMLElement>('statusBand');
const bannerCanvas = getElement<HTMLCanvasElement>('dropBanner');
const quantityValue = getElement<HTMLElement>('quantityValue');
const deadlineValue = getElement<HTMLElement>('deadlineValue');
const ddayValue = getElement<HTMLElement>('ddayValue');
const seasonGrid = getElement<HTMLElement>('seasonGrid');
const selectedSeasonName = getElement<HTMLElement>('selectedSeasonName');
const entryForm = getElement<HTMLFormElement>('entryForm');
const entryName = getElement<HTMLInputElement>('entryName');
const entryContact = getElement<HTMLInputElement>('entryContact');
const entryQuantity = getElement<HTMLSelectElement>('entryQuantity');
const entryConsent = getElement<HTMLInputElement>('entryConsent');
const entryStatus = getElement<HTMLElement>('entryStatus');

const seasonBitmaps = new Map<string, ImageBitmap>();

function renderDropSchedule(): void {
  const total = SEASON_DROPS.reduce((sum, season) => sum + season.quantity, 0);
  quantityValue.textContent = `총 ${total}점 · 패턴당 ${SEASON_DROPS[0]!.quantity}점`;

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + ENTRY_DEADLINE_DAYS);
  deadline.setHours(ENTRY_DEADLINE_HOUR, 0, 0, 0);
  deadlineValue.textContent = new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(deadline);
  ddayValue.textContent = `D-${ENTRY_DEADLINE_DAYS}`;
}

interface SeasonCard {
  root: HTMLLabelElement;
  canvas: HTMLCanvasElement;
  density: HTMLElement;
  seedRef: HTMLElement;
  palette: HTMLElement;
}

function metaCell(label: string, value: Node): HTMLElement {
  const cell = document.createElement('div');
  const caption = document.createElement('span');
  caption.textContent = label;
  cell.append(caption, value);
  return cell;
}

function createSeasonCard(season: SeasonDrop, isSelected: boolean): SeasonCard {
  const root = document.createElement('label');
  root.className = 'seasonCard';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'season';
  radio.value = season.id;
  radio.checked = isSelected;
  radio.addEventListener('change', () => selectSeason(season));

  const frame = document.createElement('div');
  frame.className = 'seasonFrame';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PREVIEW_TILE_SIZE;
  frame.append(canvas);

  const nameRow = document.createElement('div');
  nameRow.className = 'seasonName';
  const heading = document.createElement('h3');
  heading.textContent = season.name;
  const hint = document.createElement('span');
  hint.className = 'selectHint';
  hint.textContent = '이 패턴으로 응모';
  nameRow.append(heading, hint);

  const story = document.createElement('p');
  story.className = 'seasonStory';
  story.textContent = season.story;

  const quantity = document.createElement('b');
  quantity.textContent = `${season.quantity}점`;
  const density = document.createElement('b');
  density.textContent = '렌더 중';
  const seedRef = document.createElement('b');
  seedRef.textContent = '렌더 중';
  const palette = document.createElement('div');
  palette.className = 'paletteRow';

  const meta = document.createElement('div');
  meta.className = 'seasonMeta';
  meta.append(
    metaCell('수량', quantity),
    metaCell('모티프 밀도', density),
    metaCell('seedRef', seedRef),
    metaCell('팔레트', palette),
  );

  root.append(radio, frame, nameRow, story, meta);
  return { root, canvas, density, seedRef, palette };
}

function paletteSwatches(palette: readonly string[]): HTMLElement[] {
  return palette.slice(0, 5).map((color) => {
    const swatch = document.createElement('i');
    swatch.style.background = color;
    swatch.title = color;
    return swatch;
  });
}

function selectSeason(season: SeasonDrop): void {
  selectedSeasonName.textContent = season.name;
  drawBanner(season.id);
}

function drawBanner(seasonId: string): void {
  const bitmap = seasonBitmaps.get(seasonId);
  const context = bannerCanvas.getContext('2d');
  if (!bitmap || !context) {
    return;
  }

  for (let y = 0; y < bannerCanvas.height; y += BANNER_TILE_SIZE) {
    for (let x = 0; x < bannerCanvas.width; x += BANNER_TILE_SIZE) {
      context.drawImage(bitmap, x, y, BANNER_TILE_SIZE, BANNER_TILE_SIZE);
    }
  }
}

async function renderSeasons(): Promise<void> {
  seasonGrid.replaceChildren();

  for (const [index, season] of SEASON_DROPS.entries()) {
    const card = createSeasonCard(season, index === 0);
    seasonGrid.append(card.root);

    const tile = await generateTile(season.seed, card.canvas, { tileSize: PREVIEW_TILE_SIZE });
    seasonBitmaps.set(season.id, tile.bitmap);
    card.density.textContent = `${tile.meta.motifDensity} 셀 / 타일`;
    card.seedRef.textContent = tile.meta.seedRef;
    card.palette.replaceChildren(...paletteSwatches(tile.meta.palette));
  }

  const firstSeason = SEASON_DROPS[0]!;
  selectSeason(firstSeason);
}

function submitEntry(event: SubmitEvent): void {
  event.preventDefault();

  if (!entryName.value.trim() || !entryContact.value.trim()) {
    entryStatus.textContent = '이름과 연락처를 입력해주세요. (목업 화면이라 값은 저장되지 않습니다)';
    return;
  }

  if (!entryConsent.checked) {
    entryStatus.textContent = '목업 확인 항목에 동의해야 제출 안내를 볼 수 있습니다.';
    return;
  }

  entryStatus.textContent = `데모입니다 — ${selectedSeasonName.textContent} ${entryQuantity.value}점 응모는 실제로 접수되지 않았습니다. F-07은 발표용 목업 화면입니다.`;
  // form.reset()은 JS로 checked를 준 시즌 라디오까지 해제해 선택 표시가 사라진다. 입력 칸만 비운다.
  entryName.value = '';
  entryContact.value = '';
  entryConsent.checked = false;
}

entryForm.addEventListener('submit', submitEntry);
renderDropSchedule();

renderSeasons()
  .then(() => {
    statusBand.textContent = '시즌 패턴 3종을 F-02 L1 엔진으로 즉석 렌더했습니다. 응모·재고·결제 백엔드가 없는 발표용 목업 화면입니다.';
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : '시즌 패턴을 렌더하지 못했습니다.';
    statusBand.textContent = `시즌 패턴 렌더에 실패했습니다: ${detail}`;
  });
