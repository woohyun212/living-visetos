/**
 * E · AppShell 진입점 — 모듈을 계약으로만 연결한다.
 *
 * 버튼 플로우는 이제 **StateMachine(ATTRACT→OWN) 아래**에 있다.
 *   - 여정 배선: app/kiosk.ts (KioskFlow)
 *   - 상태·타임아웃: app/state.ts (TRANSITIONS / STATE_TIMEOUTS — 유일한 출처)
 *   - 화면: app/kiosk-view.ts (풀스크린 오버레이 + 상태 뱃지)
 *
 * 이 파일은 "어떻게"만 안다 — 어떤 모듈을 어떤 순서로 부르는지는 KioskFlow 가 정한다.
 * 기존 디버그 버튼 패널은 그대로 남는다(분업 경계 시연용). 같은 함수를 상태머신이 구동한다.
 * URL `?debug=1` 이면 풀스크린 연출·자동 진행·타임아웃을 끄고 예전처럼 버튼으로만 움직인다.
 */
import { KioskFlow, type KioskStep, type KioskSteps } from './app/kiosk.ts';
import { KioskView, type KioskScreen } from './app/kiosk-view.ts';
import { installOperatorControls } from './app/ops.ts';
import { StageView } from './app/stage.ts';
import { StateMachine } from './app/state.ts';
import type { DeliveryTicket, FeatureSeed, PatternTile } from './contracts.ts';
import { drawQrCode, toScannableUrl, toShortUrlLabel } from './output/qr.ts';
import { CLIP_SECONDS, deliver, record, startDeliveryRetry } from './output/recorder.ts';
import { generateTile } from './pattern/l1.ts';
import { acceptPromotedTile, promoteToL2 } from './pattern/l2.ts';
import { BagLayer } from './render/bag.ts';
import { OverlayLayer } from './render/overlay.ts';
import { CaptureService } from './vision/capture.ts';
import { installFailingCamera, installMockCamera } from './vision/mock-camera.ts';
import { extractSeed } from './vision/seed.ts';
import { Segmenter } from './vision/segmenter.ts';
import './style.css';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const DEBUG_MODE = params.get('debug') === '1';

/*
 * 개발 전용 카메라 계기 — 첫 getUserMedia 보다 **먼저** 걸어 둔다.
 *   ?mockCamera=1  카메라 없이 여정을 완주 (무인 검증)
 *   ?failCamera=1  getUserMedia 가 항상 거절 → CREATE→ERROR_RECOVER 폴백 리허설(§9)
 * 두 분기 모두 import.meta.env.DEV 가드 안이라 프로덕션 번들에서는 제거된다.
 * (운영자 데모 모드 Shift+D 는 이 가드 밖 — app/ops.ts 가 같은 목 카메라를 프로덕션에서도 쓴다.)
 */
if (import.meta.env.DEV) {
  if (params.get('failCamera') === '1') installFailingCamera();
  else if (params.get('mockCamera') === '1') installMockCamera();
}

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
const setDelivery = (info: string, ticket = '대기', label = '전달 정보') => {
  $('deliveryInfo').textContent = info;
  $('deliveryTicketBox').setAttribute('aria-label', label);
  $('deliveryTicketLabel').textContent = label;
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

/* 결과 전달 카드 (D · F-05) — url 이면 QR, code 면 오프라인 폴백 문구 (ARCHITECTURE §9). */
const resultCard = $('resultCard');

function hideResultCard(): void {
  resultCard.hidden = true;
  resultCard.classList.remove('resultCard--code');
}

async function showResultCard(ticket: DeliveryTicket): Promise<void> {
  const setCopy = (eyebrow: string, headline: string, value: string, note: string) => {
    $('resultCardEyebrow').textContent = eyebrow;
    $('resultCardHeadline').textContent = headline;
    $('resultCardValue').textContent = value;
    $('resultCardNote').textContent = note;
  };

  if (ticket.kind === 'code') {
    resultCard.classList.add('resultCard--code');
    setCopy(
      '오프라인 전달 코드',
      '나중에 이 코드로 받아가세요',
      ticket.code,
      '네트워크가 없어 결과를 키오스크에 저장했습니다. 운영자에게 이 코드를 알려주세요.',
    );
    resultCard.hidden = false;
    return;
  }

  resultCard.classList.remove('resultCard--code');
  setCopy(
    '결과 링크',
    '폰으로 스캔하세요',
    toShortUrlLabel(ticket.url),
    '폰 카메라를 QR에 비추면 결과 페이지가 열립니다.',
  );
  resultCard.hidden = false;

  try {
    await drawQrCode($<HTMLCanvasElement>('resultQrCanvas'), toScannableUrl(ticket.url));
  } catch {
    // QR 을 못 그려도 링크 글자는 남는다 — 관객이 주소를 직접 칠 수 있다.
    $('resultCardNote').textContent = 'QR을 그리지 못했습니다. 위 주소를 폰 브라우저에 직접 입력하세요.';
  }
}

/** 새 세션 시작 지점 — 앞 관객의 결과 카드가 다음 사람 화면에 남지 않게 지운다. */
function clearDeliveryResult(): void {
  session.deliveryTicket = null;
  hideResultCard();
  renderContract();
}

/* 0. 카메라 (공통 인프라) — CREATE 전반부 */
async function runCamera(): Promise<void> {
  clearDeliveryResult();
  await capture.start();
  void segmenter.init(); // wasm+모델 프리로드 — 씨앗 추출·오버레이가 기다리지 않게
  ['btnSeed', 'btnAll'].forEach((id) => {
    $<HTMLButtonElement>(id).disabled = false;
  });
}

/* 1. 모듈 A — FeatureSeed (CREATE 후반부) */
async function runSeed(): Promise<void> {
  clearDeliveryResult();
  session.seed = await extractSeed(video, { sessionId: session.id, segmenter });
  session.seed.dominantColors.forEach((col, i) => {
    ($('seedColors').children[i] as HTMLElement).style.background = col;
  });
  $('seedInfo').textContent =
    `motionEnergy ${session.seed.motionEnergy} · rhythm ${session.seed.rhythm}`;
  // 무대 연출: 방금 뽑힌 색 3개가 관객 화면에 떠오른다 (요구사항 3).
  stage?.revealSeedColors(session.seed.dominantColors);
  $<HTMLButtonElement>('btnTile').disabled = false;
  renderContract();
}

/* 2. 모듈 B — PatternTile (L1 즉시 + L2 조용한 승격) — TRANSFORM */
async function runTile(): Promise<void> {
  if (!session.seed) throw new Error('씨앗이 없습니다 — 카메라·추출을 먼저 끝내야 합니다.');
  applyTile(await generateTile(session.seed, tileCanvas));
  ['btnOverlay', 'btnBag'].forEach((id) => {
    $<HTMLButtonElement>(id).disabled = false;
  });

  // L2 승격: 도착하면 조용히 갈아 끼우고, 실패하면 아무 일도 일어나지 않는다.
  void promoteToL2(session.seed)
    .then((better) => acceptPromotedTile(better))
    .then((verified) => verified && applyTile(verified));
}
function applyTile(tile: PatternTile): void {
  session.tile = tile;
  overlay.setTile(tile);
  bag?.applyTile(tile);
  updateDeliverButton();
  renderContract();
}

/* 3. 모듈 C-1 — 실루엣 오버레이 */
function setOverlay(on: boolean): void {
  const btn = $<HTMLButtonElement>('btnOverlay');
  if (on === overlay.isRunning) return;
  if (on) {
    overlay.start();
    btn.textContent = '3. 오버레이 끄기 (C)';
  } else {
    overlay.stop();
    btn.textContent = '3. 실루엣 오버레이 (C)';
  }
  stage?.setOverlayVisible(on); // 무대에서는 오버레이가 페이드로 떠오른다
}
const toggleOverlay = (): void => setOverlay(!overlay.isRunning);

/* 4. 모듈 C-2 — 3D 가방 — MATERIALIZE */
function runBag(): void {
  bag ??= new BagLayer($('bagWrap'));
  if (session.tile) bag.applyTile(session.tile);
  updateDeliverButton();
  if (canDeliver() && !session.deliveryTicket) {
    setDelivery(`${CLIP_SECONDS}초 녹화 준비 완료 — 이름을 지으면 결과가 만들어집니다.`);
  }
}

/* 5. 모듈 D — 결과 녹화/전송 (F-05) — OWN. 이름은 상태머신이 받아 넘겨준다. */
async function runDeliver(patternName: string): Promise<void> {
  const btn = $<HTMLButtonElement>('btnDeliver');
  if (!session.tile) {
    setDelivery('먼저 패턴이 생성되어야 결과를 녹화할 수 있습니다.');
    setStatus('패턴 생성 후 다시 시도하세요.');
    return;
  }
  if (!canDeliver()) {
    setDelivery('가방 프리뷰까지 준비된 뒤에 결과 녹화를 시작할 수 있습니다.');
    setStatus('가방 프리뷰 준비 후 다시 시도하세요.');
    return;
  }

  setOverlay(true);

  btn.disabled = true;
  setDelivery('첫 실루엣 마스크 프레임을 준비한 뒤 녹화를 시작합니다.', '처리 중');
  setStatus('오버레이 첫 마스크 프레임을 준비하는 중입니다.');

  try {
    await overlay.ensureRunningAndWaitForFrame();
    setDelivery(`${CLIP_SECONDS}초 동안 실루엣 오버레이를 녹화하고 전송합니다.`, '처리 중');
    setStatus('결과 녹화/전송 중입니다. 잠시만 기다려주세요.');

    // 녹화는 무대와 같은 그림을 1080×1920 세로로 합성한다(카메라 거울 + 실루엣 오버레이).
    const pkg = await record(
      {
        video,
        overlayCanvas,
        subscribeOverlayFrame: (listener) => overlay.onFrameRendered(listener),
      },
      {
        sessionId: session.id,
        patternName,
        tileMeta: session.tile.meta,
        seconds: CLIP_SECONDS,
      },
    );
    const ticket = await deliver(pkg);
    session.deliveryTicket = ticket;
    renderContract();

    await showResultCard(ticket);

    if (ticket.kind === 'url') {
      setDelivery(`「${patternName}」 전송 완료 — 결과 페이지가 준비되었습니다.`, ticket.url, '결과 링크');
      setStatus('결과 URL이 생성되었습니다. 관객에게 QR을 스캔하도록 안내하세요.');
    } else {
      setDelivery(`「${patternName}」 오프라인 저장 완료 — 아래 코드를 안내하세요.`, ticket.code, '오프라인 전달 코드');
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

/**
 * RESET — 세션 파기 (원칙 4). 카메라·마스크·타일·오버레이·결과 카드를 전부 버리고
 * 새 sessionId 로 갈아 끼운다. 다음 관객은 앞사람의 흔적을 볼 수 없다.
 */
function destroySession(): void {
  setOverlay(false);
  // 오버레이는 stop() 만으로는 캔버스에 마지막 실루엣을 남긴다 — 루프가 segmenter 를
  // 기다리는 사이 파기가 먼저 일어나기 때문이다. dispose() 가 텍스처·renderer 를 놓고
  // 캔버스를 즉시 비운다. 다음 관객의 setTile()/start() 가 GPU 자원을 다시 세운다.
  overlay.dispose();
  capture.stop();
  segmenter.dispose(); // 마스크 ImageBitmap close + 모델 해제
  bag?.dispose();
  bag = null;
  $('bagWrap').replaceChildren();

  session.id = crypto.randomUUID();
  session.seed = null;
  session.tile = null;
  clearDeliveryResult();

  tileCanvas.getContext('2d')?.clearRect(0, 0, tileCanvas.width, tileCanvas.height);
  Array.from($('seedColors').children).forEach((el) => {
    (el as HTMLElement).style.background = '';
  });
  $('seedInfo').textContent = '아직 추출 전';
  setDelivery('패턴과 오버레이 준비 후 결과를 녹화할 수 있습니다.');

  ['btnSeed', 'btnTile', 'btnOverlay', 'btnBag', 'btnDeliver'].forEach((id) => {
    $<HTMLButtonElement>(id).disabled = true;
  });
  $<HTMLButtonElement>('btnAll').disabled = false;
  renderContract();
}

/* ── 상태머신 배선 ─────────────────────────────── */
const steps: KioskSteps = {
  clipSeconds: CLIP_SECONDS,
  warmUp: () => void segmenter.init().catch(() => {}),
  startCamera: runCamera,
  extractSeed: runSeed,
  makeTile: runTile,
  setOverlay,
  toggleOverlay,
  applyBag: runBag,
  deliver: runDeliver,
  destroySession,
  status: setStatus,
};

const machine = new StateMachine();
/*
 * 기본 모드는 관객용 무대(1080×1920 세로), ?debug=1 은 예전 계기판 그대로.
 * 두 화면 모두 KioskScreen 이므로 여정 배선(KioskFlow)은 어느 쪽인지 알 필요가 없다.
 * StageView 는 생성자에서 video/#overlayCanvas/#bagWrap/#resultCard 를 무대 안으로 옮긴다 —
 * 노드를 옮길 뿐 지우지 않으므로 canDeliver() 의 레이아웃 검사도 그대로 통과한다.
 */
const stage: StageView | null = DEBUG_MODE
  ? null
  : new StageView({ video, overlayCanvas, bagWrap: $('bagWrap'), resultCard });
const view: KioskScreen = stage ?? new KioskView({ chrome: false });
const flow = new KioskFlow({ machine, view, steps, debug: DEBUG_MODE });

const BUTTON_STEPS: [string, KioskStep][] = [
  ['btnStart', 'camera'],
  ['btnSeed', 'seed'],
  ['btnTile', 'tile'],
  ['btnOverlay', 'overlay'],
  ['btnBag', 'bag'],
  ['btnDeliver', 'deliver'],
  ['btnAll', 'all'],
];
for (const [id, step] of BUTTON_STEPS) {
  $<HTMLButtonElement>(id).onclick = () => void flow.requestStep(step);
}

/*
 * ADR-005 재시도 큐 소비 — 앱이 뜨는 순간·인터넷이 돌아오는 순간·60초마다 조용히 재전송한다.
 * 성공해도 화면은 그대로다: 관객은 이미 세션 코드를 들고 갔고, 재전송은 그 코드 그대로 올라간다.
 */
startDeliveryRetry();

document.body.classList.toggle('is-debug', DEBUG_MODE);
$('status').textContent = DEBUG_MODE
  ? '디버그 모드(?debug=1) — 상태 오버레이·타임아웃 없이 버튼으로 진행합니다.'
  : '터치하여 시작하세요.';
renderContract();

/*
 * 운영자 단축키 — 무대 모드에서만 건다(§9 폴백 매트릭스). 화면에는 목록을 그리지 않는다.
 * `stage` 가 있는 분기 안에 두었으므로 "무대 전용"이 조건문이 아니라 구조로 지켜진다.
 */
if (stage) {
  installOperatorControls({
    setDemoMode: (on) => stage.setDemoMode(on),
    resumeInDemoMode: () => flow.resumeInDemoMode(),
    forceReset: () => flow.forceReset(),
    showFallback: () => stage.showFallback(),
    hideFallback: () => stage.hideFallback(),
  });
} else {
  installDebugLinks();
}

/**
 * ?debug=1 계기판 전용 샛길 — F-07 드랍·F-08 멤버십·F-09 운영 대시보드로 가는 링크.
 *
 * index.html 이 아니라 여기서 만든다. 마크업에 두면 무대 모드에서도 DOM 에 존재하게 되고,
 * stage.css 의 "계기판 숨김 목록"(.is-stage > ...)에 선택자를 더하는 걸 잊는 순간
 * 관객 화면 위에 목업 링크가 뜬다. 디버그 분기 안에서 만들면 그 실수가 불가능해진다.
 */
function installDebugLinks(): void {
  const nav = document.createElement('nav');
  nav.className = 'debugLinks';
  nav.id = 'debugLinks';
  nav.setAttribute('aria-label', '개발·운영 화면 바로가기');

  const links: readonly [string, string][] = [
    ['/admin.html', 'F-09 운영 대시보드'],
    ['/drop.html', 'F-07 한정판 드랍 (목업)'],
    ['/membership.html', 'F-08 멤버십 시그니처 (컨셉)'],
  ];
  for (const [href, label] of links) {
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.textContent = label;
    nav.append(anchor);
  }
  $('status').after(nav);
}

/* 개발 전용 — 결과 카드를 카메라 없이 렌더해 보는 목 주입. 프로덕션 번들에서는 제거된다. */
if (import.meta.env.DEV) {
  /*
   * 폴백 리허설용 손잡이. 브라우저 콘솔·자동화 스크립트가 여정과 오버레이를 직접 찔러
   * "RESET 뒤 두 번째 세션에서도 오버레이가 다시 렌더되는가" 같은 것을 확인할 수 있게 한다.
   * (docs/OPERATIONS.md §3)
   */
  Object.assign(globalThis, { __kiosk: { flow, machine, overlay, capture, segmenter } });

  const mockTicket = params.get('mockTicket');
  if (mockTicket === 'url') {
    void showResultCard({ kind: 'url', url: `${location.origin}/results/ABCD-EFGH` });
  } else if (mockTicket === 'code') {
    void showResultCard({ kind: 'code', code: 'ABCD-EFGH' });
  }

}
