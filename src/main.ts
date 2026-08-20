/**
 * E · AppShell 진입점 — 모듈을 계약으로만 연결한다.
 * skeleton_v0.html 의 버튼 플로우를 그대로 옮긴 v0.1 (언제 멈춰도 '돌아가는 데모').
 *
 * 🚧 다음 단계(E 담당): 이 버튼 핸들러들을 StateMachine(ATTRACT→OWN) 아래로 옮기고
 *    EventBus 로 모듈 간 호출을 대체 (ARCHITECTURE §11-5).
 */
import type { DeliveryTicket, FeatureSeed, PatternTile } from './contracts.ts';
import { CLIP_SECONDS, deliver, record } from './output/recorder.ts';
import { generateTile } from './pattern/l1.ts';
import { promoteToL2 } from './pattern/l2.ts';
import { BagLayer } from './render/bag.ts';
import { OverlayLayer } from './render/overlay.ts';
import { CaptureService } from './vision/capture.ts';
import { extractSeed } from './vision/seed.ts';
import { Segmenter } from './vision/segmenter.ts';
import './style.css';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>('video');
const tileCanvas = $<HTMLCanvasElement>('tileCanvas');
const overlayCanvas = $<HTMLCanvasElement>('overlayCanvas');

const capture = new CaptureService(video);
const segmenter = new Segmenter();
const overlay = new OverlayLayer(video, overlayCanvas, segmenter);
let bag: BagLayer | null = null;

/** 세션 스코프 상태 — RESET 시 통째로 버린다 (원칙 4: 원본 프레임은 남기지 않는다). */
const session = {
  id: crypto.randomUUID(),
  seed: null as FeatureSeed | null,
  tile: null as PatternTile | null,
  deliveryTicket: null as DeliveryTicket | null,
};

const setStatus = (t: string) => ($('status').textContent = t);
const setDelivery = (info: string, ticket = '대기') => {
  $('deliveryInfo').textContent = info;
  $('deliveryTicket').textContent = ticket;
};
const canDeliver = () =>
  Boolean(
    session.tile &&
      bag &&
      overlayCanvas.isConnected &&
      overlayCanvas.offsetWidth > 0 &&
      overlayCanvas.offsetHeight > 0,
  );
const updateDeliverButton = () => {
  $<HTMLButtonElement>('btnDeliver').disabled = !canDeliver();
};
const renderContract = () => {
  const seedContract = session.seed ? JSON.stringify(session.seed) : '(대기)';
  const tileContract = session.tile
    ? JSON.stringify({ version: session.tile.version, ...session.tile.meta })
    : '(대기)';
  const deliveryContract = session.deliveryTicket
    ? JSON.stringify(session.deliveryTicket)
    : '(대기)';
  $('contract').textContent = `// 계약 뷰어 — 모듈 사이를 실제로 오가는 데이터가 여기 표시됩니다
FeatureSeed: ${seedContract}
PatternTile: ${tileContract}
DeliveryTicket: ${deliveryContract}`;
};

/* 0. 카메라 (공통 인프라) */
$<HTMLButtonElement>('btnStart').onclick = async () => {
  try {
    await capture.start();
    void segmenter.init(); // wasm+모델 프리로드 — 씨앗 추출·오버레이가 기다리지 않게
    ['btnSeed', 'btnAll'].forEach((id) => {
      $<HTMLButtonElement>(id).disabled = false;
    });
    setStatus('카메라 ON — 1번(씨앗 추출)부터 눌러보세요.');
  } catch (e) {
    // 폴백 매트릭스: 카메라 실패 → 목 시드 데모 모드로 안내 (구현은 E 과제)
    setStatus(`카메라 접근 실패: ${(e as Error).message}`);
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
  ['btnOverlay', 'btnBag'].forEach((id) => {
    $<HTMLButtonElement>(id).disabled = false;
  });
  setStatus('패턴 생성 완료 → 3번(오버레이) 또는 4번(가방)');

  // L2 승격: 도착하면 조용히 갈아 끼우고, 실패하면 아무 일도 일어나지 않는다.
  void promoteToL2(session.seed).then((better) => better && applyTile(better));
}
function applyTile(tile: PatternTile): void {
  session.tile = tile;
  overlay.setTile(tile);
  bag?.applyTile(tile);
  updateDeliverButton();
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
  updateDeliverButton();
  if (canDeliver() && !session.deliveryTicket) {
    setDelivery(`${CLIP_SECONDS}초 녹화 준비 완료 — 5번 버튼으로 결과를 남겨보세요.`);
  }
  setStatus('방금 태어난 나의 빽.');
}
$<HTMLButtonElement>('btnBag').onclick = runBag;

/* 5. 모듈 D — 결과 녹화/전송 (F-05) */
async function runDeliver(): Promise<void> {
  const btn = $<HTMLButtonElement>('btnDeliver');
  if (!session.tile) {
    setDelivery('먼저 2번에서 패턴을 생성해야 결과를 녹화할 수 있습니다.');
    setStatus('패턴 생성 후 다시 시도하세요.');
    return;
  }
  if (!canDeliver()) {
    setDelivery('4번 가방 프리뷰까지 확인한 뒤 결과 녹화를 시작할 수 있습니다.');
    setStatus('가방 프리뷰 준비 후 다시 시도하세요.');
    return;
  }

  if (!overlay.isRunning) {
    overlay.start();
    $<HTMLButtonElement>('btnOverlay').textContent = '3. 오버레이 끄기 (C)';
  }

  btn.disabled = true;
  setDelivery('첫 실루엣 마스크 프레임을 준비한 뒤 녹화를 시작합니다.', '처리 중');
  setStatus('오버레이 첫 마스크 프레임을 준비하는 중입니다.');

  try {
    await overlay.waitForFrame();
    setDelivery(`${CLIP_SECONDS}초 동안 실루엣 오버레이를 녹화하고 전송합니다.`, '처리 중');
    setStatus('결과 녹화/전송 중입니다. 잠시만 기다려주세요.');

    const pkg = await record(overlayCanvas, {
      sessionId: session.id,
      patternName: '나의 비세토스',
      tileMeta: session.tile.meta,
      seconds: CLIP_SECONDS,
    });
    const ticket = await deliver(pkg);
    session.deliveryTicket = ticket;
    renderContract();

    if (ticket.kind === 'url') {
      setDelivery('전송 완료 — 결과 페이지가 준비되었습니다.', ticket.url);
      setStatus('결과 URL이 생성되었습니다.');
    } else {
      setDelivery('오프라인 저장 완료 — 아래 세션 코드를 안내하세요.', ticket.code);
      setStatus('오프라인 코드가 발급되었습니다. 운영자에게 이 코드를 알려주세요.');
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : '알 수 없는 오류';
    setDelivery(`녹화/전송 실패 — ${message}`, '오류');
    setStatus('결과 만들기에 실패했습니다. 브라우저 녹화 권한과 네트워크를 확인하세요.');
  } finally {
    updateDeliverButton();
  }
}
$<HTMLButtonElement>('btnDeliver').onclick = runDeliver;

/* 전체 실행 — E 상태머신(ATTRACT→OWN)의 원형 */
$<HTMLButtonElement>('btnAll').onclick = async () => {
  await runSeed();
  await runTile();
  if (!overlay.isRunning) toggleOverlay();
  runBag();
  setStatus('전체 플로우 완료 — 이것이 E 모듈 상태머신(ATTRACT→OWN)의 원형입니다.');
};

renderContract();
