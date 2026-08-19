/**
 * E · AppShell 진입점 — 모듈을 계약으로만 연결한다.
 * skeleton_v0.html 의 버튼 플로우를 그대로 옮긴 v0.1 (언제 멈춰도 '돌아가는 데모').
 *
 * 🚧 다음 단계(E 담당): 이 버튼 핸들러들을 StateMachine(ATTRACT→OWN) 아래로 옮기고
 *    EventBus 로 모듈 간 호출을 대체 (ARCHITECTURE §11-5).
 */
import './style.css';
import type { FeatureSeed, PatternTile } from './contracts.ts';
import { CaptureService } from './vision/capture.ts';
import { Segmenter } from './vision/segmenter.ts';
import { extractSeed } from './vision/seed.ts';
import { generateTile } from './pattern/l1.ts';
import { acceptPromotedTile, promoteToL2 } from './pattern/l2.ts';
import { OverlayLayer } from './render/overlay.ts';
import { BagLayer } from './render/bag.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('video');
const tileCanvas = $<HTMLCanvasElement>('tileCanvas');

const capture = new CaptureService(video);
const segmenter = new Segmenter();
const overlay = new OverlayLayer(video, $<HTMLCanvasElement>('overlayCanvas'), segmenter);
let bag: BagLayer | null = null;

/** 세션 스코프 상태 — RESET 시 통째로 버린다 (원칙 4: 원본 프레임은 남기지 않는다). */
const session = {
  id: crypto.randomUUID(),
  seed: null as FeatureSeed | null,
  tile: null as PatternTile | null,
};

const setStatus = (t: string) => ($('status').textContent = t);
const renderContract = () => {
  $('contract').textContent =
    '// 계약 뷰어 — 모듈 사이를 실제로 오가는 데이터가 여기 표시됩니다\n' +
    'FeatureSeed: ' + (session.seed ? JSON.stringify(session.seed) : '(대기)') + '\n' +
    'PatternTile: ' +
    (session.tile
      ? JSON.stringify({ version: session.tile.version, ...session.tile.meta })
      : '(대기)');
};

/* 0. 카메라 (공통 인프라) */
$<HTMLButtonElement>('btnStart').onclick = async () => {
  try {
    await capture.start();
    void segmenter.init(); // wasm+모델 프리로드 — 씨앗 추출·오버레이가 기다리지 않게
    ['btnSeed', 'btnAll'].forEach((id) => ($<HTMLButtonElement>(id).disabled = false));
    setStatus('카메라 ON — 1번(씨앗 추출)부터 눌러보세요.');
  } catch (e) {
    // 폴백 매트릭스: 카메라 실패 → 목 시드 데모 모드로 안내 (구현은 E 과제)
    setStatus('카메라 접근 실패: ' + (e as Error).message);
  }
};

/* 1. 모듈 A — FeatureSeed */
async function runSeed(): Promise<void> {
  session.seed = await extractSeed(video, { sessionId: session.id, segmenter });
  session.seed.dominantColors.forEach((col, i) => {
    ($('seedColors').children[i] as HTMLElement).style.background = col;
  });
  $('seedInfo').textContent =
    `motionEnergy ${session.seed.motionEnergy} · rhythm ${session.seed.rhythm}`;
  $<HTMLButtonElement>('btnTile').disabled = false;
  renderContract();
  setStatus('씨앗 추출 완료 → 2번(패턴 생성)');
}
$<HTMLButtonElement>('btnSeed').onclick = runSeed;

/* 2. 모듈 B — PatternTile (L1 즉시 + L2 조용한 승격) */
async function runTile(): Promise<void> {
  if (!session.seed) return;
  applyTile(await generateTile(session.seed, tileCanvas));
  ['btnOverlay', 'btnBag'].forEach((id) => ($<HTMLButtonElement>(id).disabled = false));
  setStatus('패턴 생성 완료 → 3번(오버레이) 또는 4번(가방)');

  // L2 승격: 도착하면 조용히 갈아 끼우고, 실패하면 아무 일도 일어나지 않는다.
  void promoteToL2(session.seed)
    .then((better) => acceptPromotedTile(better))
    .then((verified) => verified && applyTile(verified));
}
function applyTile(tile: PatternTile): void {
  session.tile = tile;
  overlay.setTile(tile);
  bag?.applyTile(tile);
  renderContract();
}
$<HTMLButtonElement>('btnTile').onclick = runTile;

/* 3. 모듈 C-1 — 실루엣 오버레이 */
function toggleOverlay(): void {
  const btn = $<HTMLButtonElement>('btnOverlay');
  if (overlay.isRunning) {
    overlay.stop();
    btn.textContent = '3. 실루엣 오버레이 (C)';
    setStatus('오버레이 OFF');
  } else {
    overlay.start();
    btn.textContent = '3. 오버레이 끄기 (C)';
    setStatus('당신이 방금 태어난 패턴으로 변합니다.');
  }
}
$<HTMLButtonElement>('btnOverlay').onclick = toggleOverlay;

/* 4. 모듈 C-2 — 3D 가방 */
function runBag(): void {
  bag ??= new BagLayer($('bagWrap'));
  if (session.tile) bag.applyTile(session.tile);
  setStatus('방금 태어난 나의 빽.');
}
$<HTMLButtonElement>('btnBag').onclick = runBag;

/* 전체 실행 — E 상태머신(ATTRACT→OWN)의 원형 */
$<HTMLButtonElement>('btnAll').onclick = async () => {
  await runSeed();
  await runTile();
  if (!overlay.isRunning) toggleOverlay();
  runBag();
  setStatus('전체 플로우 완료 — 이것이 E 모듈 상태머신(ATTRACT→OWN)의 원형입니다.');
};

renderContract();
