import './style.css';

const PAGE_LIMIT = 20;
const ORDER_INDEX_LIMIT = 100;
const TOKEN_STORAGE_KEY = 'living-visetos.admin-token';
/** 이 폭 미만이면 포스터가 실려는 왔지만 쓸 수 없는 에셋이다(1×1 자리표시 PNG 등). */
const MIN_POSTER_WIDTH = 10;
const EXPIRY_WARNING_SECONDS = 5 * 60;

type ResultSummary = {
  code: string;
  sessionId: string;
  patternName: string;
  issuedAt: string;
  hasVideo: boolean;
  hasPoster: boolean;
};

type ResultDetail = ResultSummary & {
  tileMeta: unknown;
  videoUrl: string | null;
  posterUrl: string | null;
  assetUrlExpiresAt: string;
};

type ResultsListResponse = {
  results: ResultSummary[];
  limit: number;
  offset: number;
  hasMore: boolean;
};

type ResultDetailResponse = {
  result: ResultDetail;
};

type OrderSummary = {
  id: string;
  resultCode: string;
  visitorName: string;
  contact: string;
  productOption: string;
  consent: boolean;
  createdAt: string;
};

type OrdersResponse = {
  orders: OrderSummary[];
};

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing admin element: ${id}`);
  }
  return element as T;
};

const statusBand = getElement<HTMLElement>('statusBand');
const resultList = getElement<HTMLElement>('resultList');
const resultCount = getElement<HTMLElement>('resultCount');
const pagerRange = getElement<HTMLElement>('pagerRange');
const detailContent = getElement<HTMLElement>('detailContent');
const detailCode = getElement<HTMLElement>('detailCode');
const ttlChip = getElement<HTMLElement>('ttlChip');
const toastStack = getElement<HTMLElement>('toastStack');
const adminToken = getElement<HTMLInputElement>('adminToken');
const codeSearch = getElement<HTMLInputElement>('codeSearch');
const searchButton = getElement<HTMLButtonElement>('searchButton');
const refreshButton = getElement<HTMLButtonElement>('refreshButton');
const prevButton = getElement<HTMLButtonElement>('prevButton');
const nextButton = getElement<HTMLButtonElement>('nextButton');

let offset = 0;
let hasMore = false;
let selectedCode = '';
let listRows: ResultSummary[] = [];
/** null 이면 주문 색인 자체를 못 읽은 상태 — "주문 없음"으로 단정하지 않는다. */
let orderIndex: Map<string, number> | null = null;
let detailRequestId = 0;
let expiryTimer: number | null = null;
/** 코드당 서명 URL 자동 재발급은 1회. 무한 재조회 루프를 막는 열쇠다. */
const refreshedCodes = new Set<string>();

/* ── 상태 표시 ─────────────────────────────────────────────── */

function setStatus(message: string, isError = false): void {
  statusBand.textContent = message;
  statusBand.classList.toggle('isError', isError);
}

function toast(title: string, message: string, isAlert = false): void {
  const item = document.createElement('div');
  item.className = isAlert ? 'toast toast--alert' : 'toast';
  const heading = document.createElement('b');
  heading.textContent = title;
  const body = document.createElement('span');
  body.textContent = message;
  item.append(heading, body);
  toastStack.append(item);
  window.setTimeout(() => item.remove(), 6000);
}

function setBusy(isBusy: boolean): void {
  const authorized = hasToken();
  searchButton.disabled = isBusy;
  refreshButton.disabled = isBusy;
  prevButton.disabled = isBusy || !authorized || offset === 0;
  nextButton.disabled = isBusy || !authorized || !hasMore;
}

function hasToken(): boolean {
  return adminToken.value.trim().length > 0;
}

/* ── API ──────────────────────────────────────────────────── */

async function fetchJson<T>(path: string): Promise<T> {
  const token = adminToken.value.trim();
  const headers = new Headers({ accept: 'application/json' });
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const response = await fetch(path, { headers });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('결과 API가 JSON 응답을 반환하지 않았습니다. 로컬 dev 서버 설정을 확인하세요.');
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(readErrorMessage(body) ?? fallbackMessageFor(response.status));
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error('결과 API 응답 형식이 올바르지 않습니다.');
  }

  return body as T;
}

function fallbackMessageFor(status: number): string {
  if (status === 401 || status === 403) {
    return '운영 토큰이 필요합니다. RESULT_ADMIN_TOKEN 값을 입력하세요.';
  }

  if (status === 404) {
    return '해당 코드의 결과를 찾을 수 없습니다.';
  }

  if (status === 429) {
    return '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.';
  }

  if (status === 503) {
    return 'Supabase 결과 저장소 또는 운영 토큰이 아직 설정되지 않았습니다.';
  }

  return `요청 실패: ${status}`;
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

/* ── 목록 ─────────────────────────────────────────────────── */

async function loadList(nextOffset = offset): Promise<void> {
  if (!hasToken()) {
    renderAuthGate();
    return;
  }

  setBusy(true);
  setStatus('최근 결과를 불러오는 중입니다.');
  renderListSkeleton();

  try {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(nextOffset) });
    const data = await fetchJson<ResultsListResponse>(`/api/results?${params}`);
    offset = data.offset;
    hasMore = data.hasMore;
    orderIndex = await loadOrderIndex();
    listRows = data.results;
    renderList();
    if (!selectedCode) {
      renderDetailPrompt();
    }
    setStatus(data.results.length === 0
      ? '아직 업로드된 Supabase 결과가 없습니다. 오프라인 큐에만 남은 결과는 이 화면에 표시되지 않습니다.'
      : `${data.results.length}개 결과를 불러왔습니다.`);
  } catch (error) {
    listRows = [];
    orderIndex = null;
    const message = messageOf(error, '결과 목록을 불러오지 못했습니다.');
    renderListError(message);
    setStatus(message, true);
    toast('목록 조회 실패', message, true);
  } finally {
    setBusy(false);
  }
}

/** 목록 한 페이지의 "연결 주문" 뱃지를 채우려고 주문 색인을 한 번만 읽는다. */
async function loadOrderIndex(): Promise<Map<string, number> | null> {
  try {
    const params = new URLSearchParams({ limit: String(ORDER_INDEX_LIMIT) });
    const data = await fetchJson<OrdersResponse>(`/api/orders?${params}`);
    const index = new Map<string, number>();
    for (const order of data.orders) {
      index.set(order.resultCode, (index.get(order.resultCode) ?? 0) + 1);
    }
    return index;
  } catch {
    // 주문 조회 실패는 목록 자체를 막지 않는다 — 뱃지만 "확인 불가"로 낮춘다.
    return null;
  }
}

function renderList(): void {
  resultList.replaceChildren();
  updatePager();

  if (listRows.length === 0) {
    resultList.append(blankState({
      icon: 'inbox',
      title: '표시할 결과가 없습니다',
      body: '업로드가 끝난 세션이 아직 없습니다. 키오스크 여정을 한 번 완주하거나 다른 페이지를 확인하세요.',
    }));
    return;
  }

  for (const result of listRows) {
    resultList.append(resultRow(result));
  }
}

function resultRow(result: ResultSummary): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.setAttribute('role', 'listitem');
  row.className = result.code === selectedCode ? 'row isSelected' : 'row';
  row.setAttribute('aria-current', result.code === selectedCode ? 'true' : 'false');

  const code = document.createElement('span');
  code.className = 'cellCode';
  code.textContent = result.code;

  const pattern = document.createElement('span');
  pattern.className = 'cellPattern';
  pattern.textContent = result.patternName;
  pattern.title = result.patternName;

  const issued = document.createElement('span');
  issued.className = 'cellIssued';
  issued.textContent = formatDate(result.issuedAt);

  const assets = document.createElement('span');
  assets.className = 'cellAssets';
  assets.append(
    badge('VIDEO', result.hasVideo ? 'on' : 'off'),
    badge('POSTER', result.hasPoster ? 'on' : 'off'),
  );

  const orders = document.createElement('span');
  orders.className = 'cellOrders';
  orders.append(orderBadge(result.code));

  row.append(code, pattern, issued, assets, orders);
  row.addEventListener('click', () => {
    selectedCode = result.code;
    codeSearch.value = result.code;
    renderList();
    void loadDetail(result.code);
  });

  return row;
}

function badge(label: string, variant: 'on' | 'off' | 'solid'): HTMLElement {
  const chip = document.createElement('span');
  chip.className = `badge badge--${variant}`;
  chip.textContent = label;
  return chip;
}

function orderBadge(code: string): HTMLElement {
  if (orderIndex === null) {
    const unknown = badge('—', 'off');
    unknown.title = '주문 색인을 불러오지 못했습니다.';
    return unknown;
  }

  const count = orderIndex.get(code) ?? 0;
  if (count === 0) {
    return badge('없음', 'off');
  }

  const chip = badge(`주문 ${count}`, 'solid');
  chip.title = `${code} 로 저장된 목업 주문 ${count}건`;
  return chip;
}

function updatePager(): void {
  const authorized = hasToken();
  if (!authorized || listRows.length === 0) {
    resultCount.hidden = true;
    pagerRange.textContent = '';
    return;
  }

  resultCount.hidden = false;
  resultCount.textContent = `${listRows.length}건`;
  pagerRange.textContent = `${offset + 1}–${offset + listRows.length}`;
}

function renderListSkeleton(): void {
  resultList.replaceChildren();
  resultCount.hidden = true;
  pagerRange.textContent = '';
  for (let index = 0; index < 6; index += 1) {
    const row = document.createElement('div');
    row.className = 'skeletonRow';
    for (let cell = 0; cell < 5; cell += 1) {
      const bar = document.createElement('span');
      bar.className = 'shimmer';
      row.append(bar);
    }
    resultList.append(row);
  }
}

function renderListError(message: string): void {
  resultList.replaceChildren(blankState({
    icon: 'alert',
    title: '목록을 불러오지 못했습니다',
    body: message,
    variant: 'error',
  }));
  updatePager();
}

/* ── 상세 ─────────────────────────────────────────────────── */

async function loadDetail(code: string): Promise<void> {
  const normalized = normalizeCode(code);
  if (!normalized) {
    setStatus('조회할 세션 코드를 입력하세요.', true);
    return;
  }

  if (!hasToken()) {
    renderAuthGate();
    return;
  }

  const requestId = (detailRequestId += 1);
  setBusy(true);
  setStatus(`${normalized} 상세를 불러오는 중입니다.`);
  renderDetailSkeleton(normalized);

  try {
    const params = new URLSearchParams({ code: normalized });
    const [data, ordersData] = await Promise.all([
      fetchJson<ResultDetailResponse>(`/api/results?${params}`),
      fetchJson<OrdersResponse>(`/api/orders?${params}`),
    ]);

    if (requestId !== detailRequestId) {
      return;
    }

    selectedCode = data.result.code;
    if (listRows.length > 0) {
      renderList();
    }
    renderDetail(data.result, ordersData.orders);
    setStatus(`${data.result.code} 상세와 목업 주문 ${ordersData.orders.length}건을 불러왔습니다.`);
  } catch (error) {
    if (requestId !== detailRequestId) {
      return;
    }

    const message = messageOf(error, '상세 결과를 불러오지 못했습니다.');
    renderDetailError(message);
    setStatus(message, true);
    toast('상세 조회 실패', message, true);
  } finally {
    setBusy(false);
  }
}

function renderDetail(result: ResultDetail, orders: OrderSummary[]): void {
  detailContent.replaceChildren();
  detailCode.hidden = false;
  detailCode.textContent = result.code;

  detailContent.append(
    mediaPair(result),
    metaBlock(result),
    assetLinkBlock(result),
    tileMetaBlock(result),
    ordersBlock(orders),
  );

  startExpiryCountdown(result.assetUrlExpiresAt);
}

/** 포스터와 클립을 같은 9:16 규격으로 나란히 세운다. */
function mediaPair(result: ResultDetail): HTMLElement {
  const pair = document.createElement('div');
  pair.className = 'mediaPair';
  pair.append(
    mediaCell('포스터', posterBlock(result)),
    mediaCell('클립', videoBlock(result)),
  );
  return pair;
}

function mediaCell(label: string, frame: HTMLElement): HTMLElement {
  const cell = document.createElement('figure');
  cell.className = 'mediaCell';
  const caption = document.createElement('figcaption');
  caption.className = 'mediaCaption';
  caption.textContent = label;
  cell.append(frame, caption);
  return cell;
}

function posterBlock(result: ResultDetail): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'posterFrame';

  if (!result.posterUrl) {
    frame.append(assetPlaceholder('포스터 에셋 없음'));
    return frame;
  }

  const image = document.createElement('img');
  image.alt = `${result.code} 포스터`;
  image.decoding = 'async';
  /*
   * 1×1 자리표시 PNG 도 load 는 성공한다. 깨진 이미지 아이콘을 노출하지 않으려면
   * onerror 가 아니라 onload 에서 실제 픽셀 크기를 확인해야 한다.
   */
  image.addEventListener('load', () => {
    if (image.naturalWidth < MIN_POSTER_WIDTH || image.naturalHeight < MIN_POSTER_WIDTH) {
      image.remove();
      frame.append(assetPlaceholder('포스터 에셋 없음', '업로드된 이미지가 비어 있습니다.'));
    }
  });
  image.addEventListener('error', () => {
    // 재발급 권한이 이미 소진됐다면 "재발급 중"이라고 거짓말하지 않는다.
    const willRetry = !refreshedCodes.has(result.code);
    image.remove();
    frame.append(assetPlaceholder(
      '포스터를 불러오지 못했습니다',
      willRetry ? '서명 URL을 재발급하는 중입니다.' : '상세 조회를 다시 실행하세요.',
    ));
    void refreshSignedUrls(result.code);
  });
  image.src = result.posterUrl;

  frame.append(image);
  return frame;
}

function videoBlock(result: ResultDetail): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'videoFrame';

  if (!result.videoUrl) {
    frame.className = 'videoFrame videoFrame--empty';
    frame.append(assetPlaceholder('클립 에셋 없음'));
    return frame;
  }

  const video = document.createElement('video');
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  // <source> 자식이 아니라 엘리먼트 src 에 직접 물려야 error 이벤트가 video 로 올라온다.
  video.addEventListener('error', () => {
    void refreshSignedUrls(result.code);
  });
  video.src = result.videoUrl;

  frame.append(video);
  return frame;
}

function metaBlock(result: ResultDetail): HTMLElement {
  const block = document.createElement('div');
  block.className = 'detailBlock';

  const label = document.createElement('p');
  label.className = 'blockLabel';
  label.textContent = 'Meta';

  const list = document.createElement('dl');
  list.className = 'metaList';
  list.append(
    metaRow('코드', result.code, true),
    metaRow('세션', result.sessionId, true),
    metaRow('패턴', result.patternName),
    metaRow('발급', formatDate(result.issuedAt)),
  );

  block.append(label, list);
  return block;
}

function metaRow(label: string, value: string, mono = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'metaRow';
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.className = mono ? 'isMono' : '';
  detail.textContent = value;
  row.append(term, detail);
  return row;
}

function assetLinkBlock(result: ResultDetail): HTMLElement {
  const links = document.createElement('div');
  links.className = 'assetLinks';
  appendAssetLink(links, '비디오 원본 열기', result.videoUrl);
  appendAssetLink(links, '포스터 원본 열기', result.posterUrl);
  return links;
}

function tileMetaBlock(result: ResultDetail): HTMLElement {
  const toggle = document.createElement('details');
  toggle.className = 'tileMetaToggle';
  const summary = document.createElement('summary');
  summary.textContent = '타일 메타 (tileMeta)';
  const body = document.createElement('pre');
  body.textContent = JSON.stringify(result.tileMeta, null, 2) ?? 'null';
  toggle.append(summary, body);
  return toggle;
}

function ordersBlock(orders: OrderSummary[]): HTMLElement {
  const block = document.createElement('section');
  block.className = 'detailBlock';

  const label = document.createElement('p');
  label.className = 'blockLabel';
  label.textContent = `연결 주문 · ${orders.length}건`;
  block.append(label);

  if (orders.length === 0) {
    block.append(blankState({
      icon: 'tag',
      title: '연결된 주문 없음',
      body: '이 결과 코드로 저장된 목업 주문이 없습니다.',
      variant: 'inline',
    }));
    return block;
  }

  const list = document.createElement('div');
  for (const order of orders) {
    list.append(orderCard(order));
  }
  block.append(list);
  return block;
}

function orderCard(order: OrderSummary): HTMLElement {
  const card = document.createElement('article');
  card.className = 'orderCard';

  const head = document.createElement('div');
  head.className = 'orderHead';
  const name = document.createElement('b');
  name.textContent = order.visitorName;
  const created = document.createElement('span');
  created.textContent = formatDate(order.createdAt);
  head.append(name, created);

  const grid = document.createElement('div');
  grid.className = 'orderGrid';
  grid.append(
    orderField('연락처', order.contact),
    orderField('옵션', productOptionLabel(order.productOption)),
  );

  card.append(head, grid);
  return card;
}

function orderField(label: string, value: string): HTMLElement {
  const field = document.createElement('div');
  const caption = document.createElement('span');
  caption.textContent = label;
  const content = document.createElement('b');
  content.textContent = value;
  content.title = value;
  field.append(caption, content);
  return field;
}

function appendAssetLink(container: HTMLElement, label: string, url: string | null): void {
  if (!url) {
    return;
  }

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  container.append(link);
}

function renderDetailSkeleton(code: string): void {
  stopExpiryCountdown();
  detailCode.hidden = false;
  detailCode.textContent = code;
  detailContent.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'skeletonDetail';

  const pair = document.createElement('div');
  pair.className = 'mediaPair';
  for (let index = 0; index < 2; index += 1) {
    const frame = document.createElement('div');
    frame.className = 'posterFrame';
    const bar = document.createElement('span');
    bar.className = 'shimmer shimmer--block';
    frame.append(bar);
    pair.append(frame);
  }
  wrap.append(pair);

  for (let index = 0; index < 4; index += 1) {
    const bar = document.createElement('span');
    bar.className = 'shimmer';
    wrap.append(bar);
  }

  detailContent.append(wrap);
}

function renderDetailError(message: string): void {
  stopExpiryCountdown();
  detailContent.replaceChildren(blankState({
    icon: 'alert',
    title: '상세를 불러오지 못했습니다',
    body: message,
    variant: 'error',
  }));
}

function renderDetailPrompt(): void {
  stopExpiryCountdown();
  detailCode.hidden = true;
  detailContent.replaceChildren(blankState({
    icon: 'pointer',
    title: '결과를 선택하세요',
    body: '왼쪽 목록에서 행을 고르거나 상단에 세션 코드를 입력해 상세 조회를 실행하세요.',
  }));
}

/* ── 서명 URL 만료 대응 ─────────────────────────────────────── */

/**
 * 서명 URL 이 만료돼 에셋 로드가 실패하면 해당 코드 상세를 1회만 다시 읽어
 * 새 서명 URL 로 갈아끼운다. 코드가 바뀌면 재시도 권한도 새로 생긴다.
 */
async function refreshSignedUrls(code: string): Promise<void> {
  if (refreshedCodes.has(code) || code !== selectedCode || !hasToken()) {
    return;
  }

  refreshedCodes.add(code);
  const requestId = (detailRequestId += 1);

  try {
    const params = new URLSearchParams({ code });
    const [data, ordersData] = await Promise.all([
      fetchJson<ResultDetailResponse>(`/api/results?${params}`),
      fetchJson<OrdersResponse>(`/api/orders?${params}`),
    ]);

    // 재조회를 기다리는 동안 다른 코드로 옮겨갔다면 화면을 덮어쓰지 않는다.
    if (requestId !== detailRequestId || data.result.code !== selectedCode) {
      return;
    }

    renderDetail(data.result, ordersData.orders);
    toast('서명 URL 재발급', `${code} 에셋 주소를 새로 받아 다시 표시했습니다.`);
  } catch (error) {
    if (requestId !== detailRequestId) {
      return;
    }

    const message = messageOf(error, '서명 URL 재발급에 실패했습니다.');
    setStatus(message, true);
    toast('서명 URL 재발급 실패', message, true);
  }
}

function startExpiryCountdown(expiresAt: string): void {
  stopExpiryCountdown();
  const expiry = new Date(expiresAt).getTime();
  if (Number.isNaN(expiry)) {
    ttlChip.hidden = true;
    return;
  }

  ttlChip.hidden = false;
  const tick = (): void => {
    const remaining = Math.max(0, Math.round((expiry - Date.now()) / 1000));
    ttlChip.replaceChildren();
    const caption = document.createElement('span');
    const value = document.createElement('b');
    if (remaining === 0) {
      caption.textContent = '서명 URL 만료됨';
      value.textContent = '00:00';
    } else {
      caption.textContent = '서명 URL 만료까지';
      value.textContent = formatCountdown(remaining);
    }
    ttlChip.append(caption, value);
    ttlChip.classList.toggle('isExpiring', remaining <= EXPIRY_WARNING_SECONDS);

    if (remaining === 0) {
      stopExpiryCountdown();
    }
  };

  tick();
  expiryTimer = window.setInterval(tick, 1000);
}

function stopExpiryCountdown(): void {
  if (expiryTimer !== null) {
    window.clearInterval(expiryTimer);
    expiryTimer = null;
  }
  ttlChip.hidden = true;
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/* ── 빈 상태 · 아이콘 ───────────────────────────────────────── */

type BlankIcon = 'inbox' | 'alert' | 'key' | 'pointer' | 'film' | 'tag';

const ICON_PATHS: Record<BlankIcon, string> = {
  inbox: '<path d="M4 26h16l3 6h18l3-6h16v22a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M12 26 18 8h28l6 18"/>',
  alert: '<path d="M32 10 58 54H6z"/><path d="M32 26v14"/><path d="M32 46v.5"/>',
  key: '<circle cx="22" cy="32" r="12"/><path d="M34 32h24"/><path d="M50 32v8"/><path d="M58 32v10"/>',
  pointer: '<path d="M18 10 46 30 33 33l-5 15z"/><path d="M40 42l10 12"/>',
  film: '<rect x="6" y="14" width="52" height="36" rx="3"/><path d="M18 14v36M46 14v36M6 32h52"/>',
  tag: '<path d="M34 8H10v24l26 26 24-24z"/><circle cx="22" cy="20" r="4"/>',
};

function blankIcon(icon: BlankIcon): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', '52');
  svg.setAttribute('height', '52');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // 좌표만 담긴 고정 문자열이라 사용자 입력이 섞이지 않는다.
  svg.innerHTML = ICON_PATHS[icon];
  return svg;
}

function blankState(options: {
  icon: BlankIcon;
  title: string;
  body: string;
  hint?: string;
  variant?: 'error' | 'inline';
}): HTMLElement {
  const block = document.createElement('div');
  block.className = 'blank';
  if (options.variant === 'error') {
    block.classList.add('blank--error');
  }
  if (options.variant === 'inline' || options.variant === 'error') {
    block.classList.add('blank--inline');
  }

  const title = document.createElement('b');
  title.textContent = options.title;

  const body = document.createElement('p');
  body.textContent = options.body;

  block.append(blankIcon(options.icon), title, body);

  if (options.hint) {
    const hint = document.createElement('p');
    const code = document.createElement('code');
    code.textContent = options.hint;
    hint.append(code);
    block.append(hint);
  }

  return block;
}

function assetPlaceholder(title: string, body?: string): HTMLElement {
  const placeholder = document.createElement('div');
  placeholder.className = 'assetPlaceholder';
  placeholder.append(blankIcon('inbox'));
  const caption = document.createElement('b');
  caption.textContent = title;
  placeholder.append(caption);
  if (body) {
    const detail = document.createElement('span');
    detail.textContent = body;
    placeholder.append(detail);
  }
  return placeholder;
}

/* ── 인증 전 상태 ───────────────────────────────────────────── */

function renderAuthGate(): void {
  listRows = [];
  orderIndex = null;
  offset = 0;
  hasMore = false;
  selectedCode = '';
  stopExpiryCountdown();
  detailCode.hidden = true;

  resultList.replaceChildren(blankState({
    icon: 'key',
    title: '운영 토큰이 필요합니다',
    body: '상단의 운영 토큰 칸에 배포 환경의 값을 붙여 넣으면 최근 결과를 바로 불러옵니다. 토큰은 이 탭에만 저장되고 새로고침해도 유지됩니다.',
    hint: 'RESULT_ADMIN_TOKEN',
  }));

  detailContent.replaceChildren(blankState({
    icon: 'key',
    title: '인증 후 표시됩니다',
    body: '토큰을 입력하면 결과 상세·포스터·비디오와 연결된 목업 주문을 볼 수 있습니다.',
  }));

  updatePager();
  setStatus('운영 토큰을 입력하면 최근 결과를 불러옵니다.');
  setBusy(false);
}

/* ── 포맷 ─────────────────────────────────────────────────── */

function normalizeCode(value: string): string {
  return value.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function productOptionLabel(value: string): string {
  if (value === 'classic-tote') return 'Classic tote mock';
  if (value === 'mini-tote') return 'Mini tote mock';
  if (value === 'flat-pouch') return 'Flat pouch mock';
  return value;
}

/* ── 토큰 보존 ──────────────────────────────────────────────── */

function readStoredToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(value: string): void {
  try {
    if (value) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // 시크릿 창 등 sessionStorage 를 못 쓰는 환경에서도 조회 자체는 계속된다.
  }
}

/* ── 이벤트 ───────────────────────────────────────────────── */

async function searchDetailAndRefreshList(): Promise<void> {
  const normalized = normalizeCode(codeSearch.value);
  if (!normalized) {
    setStatus('조회할 세션 코드를 입력하세요.', true);
    return;
  }

  await loadDetail(normalized);
  await loadList(0);
}

searchButton.addEventListener('click', () => void searchDetailAndRefreshList());
refreshButton.addEventListener('click', () => void loadList(0));
prevButton.addEventListener('click', () => void loadList(Math.max(0, offset - PAGE_LIMIT)));
nextButton.addEventListener('click', () => void loadList(offset + PAGE_LIMIT));

codeSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void searchDetailAndRefreshList();
  }
});

adminToken.addEventListener('input', () => {
  const value = adminToken.value.trim();
  adminToken.classList.toggle('isFilled', value.length > 0);
  storeToken(value);
  // 코드마다 붙던 재시도 권한은 자격 증명이 바뀌면 초기화한다.
  refreshedCodes.clear();
  if (value.length === 0) {
    renderAuthGate();
  }
});

adminToken.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void loadList(0);
  }
});

const restoredToken = readStoredToken();
if (restoredToken) {
  adminToken.value = restoredToken;
  adminToken.classList.add('isFilled');
  renderDetailPrompt();
  void loadList(0);
} else {
  renderAuthGate();
}
