import './style.css';

/*
 * F-06 결과 페이지. 관객이 QR 을 찍고 자기 폰에서 여는 화면이라
 * 1) 영상이 먼저 보이고, 2) 인증 카드가 한정판 1점의 근거를 말하고,
 * 3) 저장/공유 유도, 4) 목업 주문 순서로 내려간다.
 *
 * 서명 URL 은 기본 1시간이면 만료된다(api/results.ts RESULT_ASSET_URL_TTL_SECONDS).
 * 관객이 페이지를 열어둔 채 한참 뒤에 재생하면 403 이 나므로, 애셋 오류가 나면
 * 결과를 한 번만 다시 조회해 새 서명 URL 로 갈아끼운다.
 */

type TileMeta = {
  palette?: unknown;
  spacing?: unknown;
  motifDensity?: unknown;
};

type PublicResultDetail = {
  code: string;
  patternName: string;
  issuedAt: string;
  posterUrl: string | null;
  videoUrl: string | null;
  assetUrlExpiresAt: string;
  /*
   * 공개 상세(api/results.ts toPublicDetail)는 현재 tileMeta 를 내려주지 않는다.
   * 프론트 전용 변경이라 API 는 건드리지 않고, 값이 오는 순간 접힘 블록이 켜지도록 선택 필드로 읽는다.
   */
  tileMeta?: TileMeta | null;
};

type ResultDetailResponse = {
  result: PublicResultDetail;
};

type OrderResponse = {
  orderId: string;
};

class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const RESULT_CODE_PATTERN = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing result element: ${id}`);
  }
  return element as T;
};

const hero = getElement<HTMLElement>('hero');
const stageVideo = getElement<HTMLVideoElement>('resultVideo');
const stageFallback = getElement<HTMLElement>('stageFallback');
const saveHint = getElement<HTMLElement>('saveHint');
const statusBand = getElement<HTMLElement>('statusBand');

const certCard = getElement<HTMLElement>('certCard');
const certName = getElement<HTMLElement>('certTitle');
const certIssuedAt = getElement<HTMLElement>('certIssuedAt');
const certCode = getElement<HTMLElement>('certCode');
const tileMetaBlock = getElement<HTMLDetailsElement>('tileMeta');
const paletteRow = getElement<HTMLElement>('paletteRow');
const paletteSwatches = getElement<HTMLElement>('paletteSwatches');
const spacingRow = getElement<HTMLElement>('spacingRow');
const spacingValue = getElement<HTMLElement>('spacingValue');
const densityRow = getElement<HTMLElement>('densityRow');
const densityValue = getElement<HTMLElement>('densityValue');

const shareButton = getElement<HTMLButtonElement>('shareButton');
const videoLink = getElement<HTMLAnchorElement>('videoLink');
const copyFallback = getElement<HTMLElement>('copyFallback');
const copyField = getElement<HTMLInputElement>('copyField');
const shareStatus = getElement<HTMLElement>('shareStatus');

const emptyCard = getElement<HTMLElement>('emptyCard');
const emptyTitle = getElement<HTMLElement>('emptyTitle');
const emptyBody = getElement<HTMLElement>('emptyBody');
const retryButton = getElement<HTMLButtonElement>('retryButton');

const orderCard = getElement<HTMLElement>('orderCard');
const orderForm = getElement<HTMLFormElement>('orderForm');
const visitorName = getElement<HTMLInputElement>('visitorName');
const contact = getElement<HTMLInputElement>('contact');
const productOption = getElement<HTMLSelectElement>('productOption');
const consent = getElement<HTMLInputElement>('consent');
const submitButton = getElement<HTMLButtonElement>('submitButton');
const formStatus = getElement<HTMLElement>('formStatus');
const orderDone = getElement<HTMLElement>('orderDone');
const orderIdValue = getElement<HTMLElement>('orderIdValue');
const orderAgainButton = getElement<HTMLButtonElement>('orderAgainButton');

let resultCode = normalizeCode(codeFromLocation());
let resultLoaded = false;
let posterUrl: string | null = null;
/** 영상·포스터가 동시에 만료돼도 재조회는 페이지당 한 번만 돈다. */
let assetRefreshUsed = false;
let assetRefreshInFlight = false;
let submitting = false;

// ── 상태 표시 ───────────────────────────────────

function setStatus(message: string | null): void {
  statusBand.textContent = message ?? '';
  statusBand.hidden = message === null;
}

function setFormStatus(message: string, tone: 'quiet' | 'error' = 'quiet'): void {
  formStatus.textContent = message;
  formStatus.dataset.tone = tone;
}

function setHeroState(state: 'loading' | 'ready' | 'fallback'): void {
  hero.dataset.state = state;
}

function syncSubmitAvailability(): void {
  submitButton.disabled = submitting || !resultLoaded;
}

// ── API ─────────────────────────────────────────

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('네트워크 연결이 끊겼습니다.', 0);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError('결과 서버가 예상과 다른 응답을 보냈습니다.', response.status);
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(readErrorMessage(body) ?? `요청 실패: ${response.status}`, response.status);
  }

  if (typeof body !== 'object' || body === null) {
    throw new ApiError('결과 서버 응답 형식이 올바르지 않습니다.', response.status);
  }

  return body as T;
}

function readErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null;
  }

  const { error, detail } = body as { error: unknown; detail?: unknown };
  if (typeof error !== 'string') {
    return null;
  }

  return typeof detail === 'string' && detail.length > 0 ? `${error} ${detail}` : error;
}

async function requestResult(code: string): Promise<PublicResultDetail> {
  const params = new URLSearchParams({ code });
  const data = await fetchJson<ResultDetailResponse>(`/api/results?${params}`);
  return data.result;
}

// ── 로딩 ────────────────────────────────────────

async function loadResult(): Promise<void> {
  if (!resultCode) {
    showEmpty(
      '결과 주소가 완전하지 않아요',
      '주소에 결과 코드가 없습니다. 키오스크 화면의 QR을 다시 찍거나, 화면에 뜬 세션 코드를 확인해 주세요.',
    );
    return;
  }

  if (!RESULT_CODE_PATTERN.test(resultCode)) {
    showEmpty(
      '코드 형식이 달라요',
      `'${resultCode}' 는 결과 코드 형식(ABCD-1234)이 아닙니다. 키오스크 화면의 세션 코드를 다시 확인해 주세요.`,
    );
    return;
  }

  setHeroState('loading');
  hero.hidden = false;
  emptyCard.hidden = true;
  setStatus('결과를 불러오는 중입니다.');
  resultLoaded = false;
  syncSubmitAvailability();

  try {
    const result = await requestResult(resultCode);
    resultCode = result.code;
    resultLoaded = true;
    assetRefreshUsed = false;
    applyResult(result);
    certCard.hidden = false;
    orderCard.hidden = false;
    setStatus(null);
    setFormStatus('');
  } catch (error) {
    resultLoaded = false;
    showEmptyForError(error);
  } finally {
    syncSubmitAvailability();
  }
}

function applyResult(result: PublicResultDetail): void {
  certName.textContent = result.patternName || '이름 없는 패턴';
  certIssuedAt.textContent = formatDate(result.issuedAt);
  certCode.textContent = result.code;

  renderTileMeta(result.tileMeta ?? null);
  applyAssets(result);
  setupShare(result);
}

/** 서명 URL 만 갈아끼운다 — 만료 재조회에서도 같은 경로를 쓴다. */
function applyAssets(result: PublicResultDetail): void {
  posterUrl = result.posterUrl;

  if (!result.videoUrl) {
    stageVideo.hidden = true;
    stageVideo.removeAttribute('src');
    saveHint.hidden = true;
    videoLink.hidden = true;
    showStagePlaceholder();
    return;
  }

  videoLink.href = result.videoUrl;
  videoLink.hidden = false;
  saveHint.hidden = false;
  stageVideo.hidden = false;

  /*
   * poster 속성은 로드 실패를 알려주지 않는다. 먼저 Image 로 찔러보고
   * 성공한 것만 붙여야 깨진 포스터가 첫 화면이 되는 일을 막는다.
   */
  probeImage(posterUrl).then((loadedPosterUrl) => {
    if (loadedPosterUrl) {
      stageVideo.poster = loadedPosterUrl;
    } else {
      stageVideo.removeAttribute('poster');
      if (posterUrl) {
        void refreshAssets('포스터를 다시 불러오는 중입니다.');
      }
    }
  });

  // src 를 <source> 자식이 아니라 요소에 직접 둬야 error 이벤트가 올라온다.
  stageVideo.src = result.videoUrl;
  stageVideo.load();
  setHeroState('ready');
}

function showStagePlaceholder(): void {
  // 영상이 없어도 포스터가 살아 있으면 포스터를 무대에 세운다.
  if (posterUrl) {
    void probeImage(posterUrl).then((loadedPosterUrl) => {
      if (loadedPosterUrl) {
        stageFallback.style.backgroundImage = `url("${loadedPosterUrl}")`;
        stageFallback.style.backgroundSize = 'contain';
        stageFallback.style.backgroundPosition = 'center';
        stageFallback.style.backgroundRepeat = 'no-repeat';
      }
    });
  }

  setHeroState('fallback');
}

function probeImage(url: string | null): Promise<string | null> {
  if (!url) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(url);
    probe.onerror = () => resolve(null);
    probe.src = url;
  });
}

/** 만료된 서명 URL 복구. 페이지당 한 번만 돌고, 그다음부터는 사람 말로 안내한다. */
async function refreshAssets(pendingMessage: string): Promise<void> {
  if (assetRefreshInFlight) {
    return;
  }

  if (assetRefreshUsed || !resultCode) {
    setStatus('영상 주소의 유효 시간이 지났어요. 화면을 새로고침하면 다시 불러옵니다.');
    return;
  }

  assetRefreshUsed = true;
  assetRefreshInFlight = true;
  setStatus(pendingMessage);

  try {
    const result = await requestResult(resultCode);
    applyAssets(result);
    setupShare(result);
    setStatus(null);
  } catch {
    stageVideo.hidden = true;
    showStagePlaceholder();
    setStatus('영상 주소의 유효 시간이 지났어요. 화면을 새로고침하면 다시 불러옵니다.');
  } finally {
    assetRefreshInFlight = false;
  }
}

stageVideo.addEventListener('error', () => {
  if (stageVideo.hidden) {
    return;
  }

  if (assetRefreshUsed) {
    stageVideo.hidden = true;
    saveHint.hidden = true;
    showStagePlaceholder();
    setStatus('영상 주소의 유효 시간이 지났어요. 화면을 새로고침하면 다시 불러옵니다.');
    return;
  }

  void refreshAssets('영상을 다시 불러오는 중입니다.');
});

// ── 타일 메타 (있을 때만) ────────────────────────

function renderTileMeta(meta: TileMeta | null): void {
  const palette = readStringArray(meta?.palette);
  const spacing = readNumber(meta?.spacing);
  const density = readNumber(meta?.motifDensity);

  if (palette.length === 0 && spacing === null && density === null) {
    tileMetaBlock.hidden = true;
    return;
  }

  paletteSwatches.replaceChildren();
  for (const color of palette) {
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = color;
    swatch.title = color;
    paletteSwatches.append(swatch);
  }

  paletteRow.hidden = palette.length === 0;

  spacingRow.hidden = spacing === null;
  spacingValue.textContent = spacing === null ? '—' : `${roundTo(spacing, 2)}`;

  densityRow.hidden = density === null;
  densityValue.textContent = density === null ? '—' : `${Math.round(density * 100)}%`;

  tileMetaBlock.hidden = false;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  // CSS 색으로 그대로 넣을 값이라 문법을 만족하는 항목만 통과시킨다.
  return value.filter(
    (item): item is string => typeof item === 'string' && CSS.supports('color', item),
  );
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ── 저장 / 공유 ─────────────────────────────────

function setupShare(result: PublicResultDetail): void {
  const shareUrl = new URL(`/results/${result.code}`, window.location.origin).toString();
  copyField.value = shareUrl;

  const canShare = typeof navigator.share === 'function';
  const canCopy = typeof navigator.clipboard?.writeText === 'function';

  if (!canShare && !canCopy) {
    /*
     * 평문 HTTP 배포처럼 보안 컨텍스트가 아니면 navigator.share 도 clipboard 도 없다.
     * 이때는 버튼 대신 길게 눌러 복사할 수 있는 주소 필드를 남긴다.
     */
    shareButton.hidden = true;
    copyFallback.hidden = false;
    return;
  }

  shareButton.hidden = false;
  copyFallback.hidden = true;
  shareButton.textContent = canShare ? '공유하기' : '주소 복사';
  shareButton.onclick = () => {
    void runShare(shareUrl, result.patternName, canShare);
  };
}

async function runShare(shareUrl: string, patternName: string, canShare: boolean): Promise<void> {
  // navigator.share 는 사용자 제스처 안에서만 열리므로 클릭 핸들러에서 바로 부른다.
  if (canShare) {
    try {
      await navigator.share({
        title: '리빙 비세토스',
        text: `${patternName} — 나만의 패턴 1점`,
        url: shareUrl,
      });
      shareStatus.textContent = '';
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      // 공유 시트를 못 열면 복사로 내려간다.
    }
  }

  try {
    await navigator.clipboard.writeText(shareUrl);
    shareStatus.textContent = '주소를 복사했어요. 원하는 곳에 붙여 넣어 주세요.';
  } catch {
    shareButton.hidden = true;
    copyFallback.hidden = false;
    shareStatus.textContent = '';
  }
}

// ── 빈 상태 ─────────────────────────────────────

function showEmpty(title: string, body: string): void {
  emptyTitle.textContent = title;
  emptyBody.textContent = body;
  emptyCard.hidden = false;
  certCard.hidden = true;
  orderCard.hidden = true;
  stageVideo.hidden = true;
  saveHint.hidden = true;
  // 볼 결과가 아예 없을 때 빈 9:16 무대를 세워두면 고장처럼 보인다. 안내를 첫 화면으로 올린다.
  hero.hidden = true;
  setStatus(null);
}

function showEmptyForError(error: unknown): void {
  const status = error instanceof ApiError ? error.status : -1;

  if (status === 404) {
    showEmpty(
      '이 코드의 결과가 아직 없어요',
      `${resultCode} 로 만들어진 결과를 찾지 못했습니다. 방금 촬영했다면 업로드가 끝나기 전일 수 있어요.`,
    );
    return;
  }

  if (status === 429) {
    showEmpty(
      '조회가 잠시 몰렸어요',
      '한 번에 많은 분이 결과를 열고 있습니다. 잠시 뒤 다시 시도해 주세요.',
    );
    return;
  }

  if (status === 503) {
    showEmpty(
      '결과 보관소를 준비하는 중이에요',
      '결과 저장소가 아직 연결되지 않았습니다. 잠시 뒤 다시 시도하거나 현장 스태프에게 알려주세요.',
    );
    return;
  }

  if (status === 0) {
    showEmpty(
      '연결이 끊겼어요',
      '네트워크 상태를 확인한 뒤 다시 시도해 주세요. 전시장 Wi-Fi 신호가 약할 수 있습니다.',
    );
    return;
  }

  showEmpty(
    '결과를 불러오지 못했어요',
    '잠시 뒤 다시 시도해 주세요. 계속 같은 화면이 보이면 현장 스태프에게 알려주세요.',
  );
}

retryButton.addEventListener('click', () => {
  void loadResult();
});

// ── 목업 주문 ───────────────────────────────────

async function submitOrder(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!resultLoaded || !resultCode) {
    setFormStatus('결과를 먼저 불러와야 목업 주문을 남길 수 있어요.', 'error');
    return;
  }

  if (!orderForm.reportValidity()) {
    return;
  }

  submitting = true;
  syncSubmitAvailability();
  setFormStatus('목업 주문을 저장하는 중입니다.');

  try {
    const data = await fetchJson<OrderResponse>('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resultCode,
        visitorName: visitorName.value,
        contact: contact.value,
        productOption: productOption.value,
        consent: consent.checked,
      }),
    });
    orderForm.reset();
    setFormStatus('');
    orderIdValue.textContent = data.orderId;
    orderForm.hidden = true;
    orderDone.hidden = false;
  } catch (error) {
    setFormStatus(
      error instanceof ApiError && error.status === 429
        ? '주문이 잠시 몰렸어요. 잠시 뒤 다시 시도해 주세요.'
        : '목업 주문을 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
      'error',
    );
  } finally {
    submitting = false;
    syncSubmitAvailability();
  }
}

orderAgainButton.addEventListener('click', () => {
  orderDone.hidden = true;
  orderForm.hidden = false;
  visitorName.focus();
});

orderForm.addEventListener('submit', (event) => void submitOrder(event));

// ── 코드 파싱 / 포맷 ─────────────────────────────

function codeFromLocation(): string {
  const queryCode = new URLSearchParams(window.location.search).get('code');
  if (queryCode) {
    return queryCode;
  }

  const segments = window.location.pathname.split('/').filter(Boolean);
  return segments[0] === 'results' ? segments[1] ?? '' : '';
}

function normalizeCode(value: string): string {
  return value.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  /*
   * 증서에 들어가는 값이라 좁은 폰에서도 한 줄로 떨어져야 한다.
   * 'ko-KR' 의 dateStyle/timeStyle 조합은 '오후 3:30' 이 중간에서 줄바꿈되므로 직접 조립한다.
   */
  const parts = new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';

  return `${pick('year')}.${pick('month')}.${pick('day')} ${pick('hour')}:${pick('minute')}`;
}

syncSubmitAvailability();
void loadResult();
