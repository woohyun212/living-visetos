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
 * 응모 폼은 목업이다 — 백엔드가 없고, 제출은 목업 접수 화면만 띄운다.
 */

interface SeasonDrop {
  id: string;
  name: string;
  latin: string;
  story: string;
  quantity: number;
  /** 마감은 시즌마다 다르다. 목업이 언제 시연되어도 살아 있도록 로드 시각 기준 오프셋으로 잡는다. */
  closesInDays: number;
  seed: FeatureSeed;
}

/**
 * motionEnergy는 style(minimal/rhythmic/dynamic) 구간을, rhythm은 배치·디테일 단계를,
 * dominantColors[0]의 명도는 팔레트 모드를 가른다. 세 시즌이 서로 다른 구간에 놓이도록 골랐다.
 */
const SEASON_DROPS: readonly SeasonDrop[] = [
  {
    id: 'aurum',
    name: 'AURUM',
    latin: '오럼 · MINIMAL',
    story: '느린 호흡의 관객에게서 나온 최소 밀도 문법. 큰 엠블럼과 넓은 여백이 코냑 톤 위에 놓인다.',
    quantity: 100,
    closesInDays: 5,
    seed: {
      dominantColors: ['#D8C39B', '#F1E7D4', '#9A6A34'],
      motionEnergy: 0.18,
      rhythm: 0.16,
      sessionId: 'drop-2026ss-aurum',
    },
  },
  {
    id: 'verdant',
    name: 'VERDANT',
    latin: '베르당 · RHYTHMIC',
    story: '중간 리듬 구간의 교대 배치. 엠블럼과 마름모가 같은 비중으로 번갈아 나타난다.',
    quantity: 100,
    closesInDays: 12,
    seed: {
      dominantColors: ['#7E9C86', '#E4EDE3', '#2F4A38'],
      motionEnergy: 0.50,
      rhythm: 0.52,
      sessionId: 'drop-2026ss-verdant',
    },
  },
  {
    id: 'noctis',
    name: 'NOCTIS',
    latin: '녹티스 · DYNAMIC',
    story: '가장 빠른 모션 구간에서 태어난 고밀도 문법. 어두운 관객색이 팔레트를 다크 모드로 뒤집는다.',
    quantity: 100,
    closesInDays: 19,
    seed: {
      dominantColors: ['#232B36', '#8FA3BC', '#C9D6E6'],
      motionEnergy: 0.86,
      rhythm: 0.88,
      sessionId: 'drop-2026ss-noctis',
    },
  },
];

const PREVIEW_TILE_SIZE = 512;
const HERO_CELL_SIZE = 880;
const RIBBON_CELL_SIZE = 132;
const ENTRY_DEADLINE_HOUR = 20;
const COUNTDOWN_INTERVAL_MS = 1000;

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing drop element: ${id}`);
  }
  return element as T;
};

const statusBand = getElement<HTMLElement>('statusBand');
const heroCanvas = getElement<HTMLCanvasElement>('dropHeroCanvas');
const ribbonCanvas = getElement<HTMLCanvasElement>('dropBanner');
const heroSeasonName = getElement<HTMLElement>('heroSeasonName');
const heroSeasonQuantity = getElement<HTMLElement>('heroSeasonQuantity');
const clockDays = getElement<HTMLElement>('clockDays');
const clockHours = getElement<HTMLElement>('clockHours');
const clockMinutes = getElement<HTMLElement>('clockMinutes');
const clockSeconds = getElement<HTMLElement>('clockSeconds');
const deadlineValue = getElement<HTMLElement>('deadlineValue');
const quantityValue = getElement<HTMLElement>('quantityValue');
const seasonGrid = getElement<HTMLElement>('seasonGrid');
const selectedSeasonName = getElement<HTMLElement>('selectedSeasonName');
const selectedSeasonDeadline = getElement<HTMLElement>('selectedSeasonDeadline');
const entryForm = getElement<HTMLFormElement>('entryForm');
const entryName = getElement<HTMLInputElement>('entryName');
const entryContact = getElement<HTMLInputElement>('entryContact');
const entryQuantity = getElement<HTMLSelectElement>('entryQuantity');
const entryConsent = getElement<HTMLInputElement>('entryConsent');
const entryStatus = getElement<HTMLElement>('entryStatus');
const entryDone = getElement<HTMLElement>('entryDone');
const entryReset = getElement<HTMLButtonElement>('entryReset');
const doneSeason = getElement<HTMLElement>('doneSeason');
const doneQuantity = getElement<HTMLElement>('doneQuantity');
const doneTicket = getElement<HTMLElement>('doneTicket');
const doneDeadline = getElement<HTMLElement>('doneDeadline');

const dateTimeFormat = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'long',
  timeStyle: 'short',
});

const seasonBitmaps = new Map<string, ImageBitmap>();
const seasonDeadlines = new Map<string, Date>();
const cardCountdowns = new Map<string, HTMLElement>();
let selectedSeason: SeasonDrop = SEASON_DROPS[0]!;

/** 마감은 페이지를 연 시각 기준으로 계산해 목업이 만료되지 않게 한다. */
function deadlineFor(season: SeasonDrop): Date {
  const cached = seasonDeadlines.get(season.id);
  if (cached) {
    return cached;
  }

  const deadline = new Date();
  deadline.setDate(deadline.getDate() + season.closesInDays);
  deadline.setHours(ENTRY_DEADLINE_HOUR, 0, 0, 0);
  seasonDeadlines.set(season.id, deadline);
  return deadline;
}

interface Remaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

function remainingUntil(deadline: Date): Remaining {
  const totalSeconds = Math.floor((deadline.getTime() - Date.now()) / 1000);
  if (totalSeconds <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }

  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: false,
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** 히어로 시계와 카드 카운트다운을 1초마다 같은 소스로 갱신한다. */
function tickCountdowns(): void {
  const hero = remainingUntil(deadlineFor(selectedSeason));
  clockDays.textContent = pad(hero.days);
  clockHours.textContent = pad(hero.hours);
  clockMinutes.textContent = pad(hero.minutes);
  clockSeconds.textContent = pad(hero.seconds);

  for (const season of SEASON_DROPS) {
    const target = cardCountdowns.get(season.id);
    if (!target) {
      continue;
    }

    const left = remainingUntil(deadlineFor(season));
    target.textContent = left.expired
      ? '마감'
      : `D-${left.days} · ${pad(left.hours)}:${pad(left.minutes)}:${pad(left.seconds)}`;
  }
}

function renderDropSchedule(): void {
  const total = SEASON_DROPS.reduce((sum, season) => sum + season.quantity, 0);
  quantityValue.textContent = `총 ${total}점 · 패턴당 ${SEASON_DROPS[0]!.quantity}점`;
}

interface SeasonCard {
  root: HTMLLabelElement;
  canvas: HTMLCanvasElement;
  countdown: HTMLElement;
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

function chip(text: string, modifier?: string): HTMLElement {
  const element = document.createElement('span');
  element.className = modifier ? `chip ${modifier}` : 'chip';
  element.textContent = text;
  return element;
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
  const chips = document.createElement('div');
  chips.className = 'cardChips';
  chips.append(chip('응모 중', 'chip--live'), chip(`${season.quantity}점 한정`));
  frame.append(canvas, chips);

  const nameRow = document.createElement('div');
  nameRow.className = 'seasonName';
  const heading = document.createElement('h3');
  heading.textContent = season.name;
  const latin = document.createElement('em');
  latin.textContent = season.latin;
  nameRow.append(heading, latin);

  const story = document.createElement('p');
  story.className = 'seasonStory';
  story.textContent = season.story;

  const countdownRow = document.createElement('div');
  countdownRow.className = 'cardCountdown';
  const countdownLabel = document.createElement('span');
  countdownLabel.textContent = '응모 마감까지';
  const countdown = document.createElement('b');
  countdown.textContent = 'D-—';
  countdownRow.append(countdownLabel, countdown);

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

  const hint = document.createElement('span');
  hint.className = 'selectHint';
  hint.textContent = '이 패턴으로 응모';

  root.append(radio, frame, nameRow, story, countdownRow, meta, hint);
  return { root, canvas, countdown, density, seedRef, palette };
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
  selectedSeason = season;
  const deadlineText = dateTimeFormat.format(deadlineFor(season));

  heroSeasonName.textContent = season.name;
  heroSeasonQuantity.textContent = `${season.latin} · ${season.quantity}점 한정`;
  selectedSeasonName.textContent = season.name;
  selectedSeasonDeadline.textContent = `${season.latin} · 마감 ${deadlineText}`;
  deadlineValue.textContent = deadlineText;

  drawTiled(heroCanvas, season.id, HERO_CELL_SIZE);
  drawTiled(ribbonCanvas, season.id, RIBBON_CELL_SIZE);
  tickCountdowns();
}

/** 심리스 타일을 격자로 반복해 히어로·리본을 채운다 — 원단 전개를 그대로 보여주는 방식. */
function drawTiled(canvas: HTMLCanvasElement, seasonId: string, cellSize: number): void {
  const bitmap = seasonBitmaps.get(seasonId);
  const context = canvas.getContext('2d');
  if (!bitmap || !context) {
    return;
  }

  for (let y = 0; y < canvas.height; y += cellSize) {
    for (let x = 0; x < canvas.width; x += cellSize) {
      context.drawImage(bitmap, x, y, cellSize, cellSize);
    }
  }
}

async function renderSeasons(): Promise<void> {
  seasonGrid.replaceChildren();

  const cards = SEASON_DROPS.map((season, index) => {
    const card = createSeasonCard(season, index === 0);
    seasonGrid.append(card.root);
    cardCountdowns.set(season.id, card.countdown);
    return { card, season };
  });

  tickCountdowns();

  // 세 타일을 동시에 렌더한다 — 히어로가 카드보다 늦게 채워지는 빈 프레임이 생기지 않게.
  await Promise.all(cards.map(async ({ card, season }) => {
    const tile = await generateTile(season.seed, card.canvas, { tileSize: PREVIEW_TILE_SIZE });
    seasonBitmaps.set(season.id, tile.bitmap);
    card.density.textContent = `${tile.meta.motifDensity} 셀 / 타일`;
    card.seedRef.textContent = tile.meta.seedRef;
    card.palette.replaceChildren(...paletteSwatches(tile.meta.palette));
  }));

  selectSeason(SEASON_DROPS[0]!);
}

/** 목업 접수번호 — 저장되지 않으며 화면 시연용으로만 만든다. */
function mockTicket(season: SeasonDrop): string {
  const serial = Math.floor(Math.random() * 9000) + 1000;
  return `LV-F07-${season.id.slice(0, 3).toUpperCase()}-${serial}`;
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

  doneSeason.textContent = `${selectedSeason.name} · ${selectedSeason.latin}`;
  doneQuantity.textContent = `${entryQuantity.value}점`;
  doneTicket.textContent = mockTicket(selectedSeason);
  doneDeadline.textContent = dateTimeFormat.format(deadlineFor(selectedSeason));

  entryStatus.textContent = '';
  entryForm.hidden = true;
  entryDone.hidden = false;
  entryDone.focus();
}

function resetEntry(): void {
  // form.reset()은 JS로 checked를 준 시즌 라디오까지 해제해 선택 표시가 사라진다. 입력 칸만 비운다.
  entryName.value = '';
  entryContact.value = '';
  entryQuantity.value = '1';
  entryConsent.checked = false;
  entryStatus.textContent = '';
  entryDone.hidden = true;
  entryForm.hidden = false;
  entryName.focus();
}

entryForm.addEventListener('submit', submitEntry);
entryReset.addEventListener('click', resetEntry);
renderDropSchedule();
tickCountdowns();
window.setInterval(tickCountdowns, COUNTDOWN_INTERVAL_MS);

renderSeasons()
  .then(() => {
    statusBand.textContent = '시즌 패턴 3종을 F-02 L1 엔진으로 즉석 렌더했습니다. 응모·재고·결제 백엔드가 없는 발표용 목업 화면입니다.';
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : '시즌 패턴을 렌더하지 못했습니다.';
    statusBand.textContent = `시즌 패턴 렌더에 실패했습니다: ${detail}`;
  });
