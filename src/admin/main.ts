import './style.css';

const PAGE_LIMIT = 20;

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
const detailContent = getElement<HTMLElement>('detailContent');
const adminToken = getElement<HTMLInputElement>('adminToken');
const codeSearch = getElement<HTMLInputElement>('codeSearch');
const searchButton = getElement<HTMLButtonElement>('searchButton');
const refreshButton = getElement<HTMLButtonElement>('refreshButton');
const prevButton = getElement<HTMLButtonElement>('prevButton');
const nextButton = getElement<HTMLButtonElement>('nextButton');

let offset = 0;
let hasMore = false;
let selectedCode = '';

function setStatus(message: string): void {
  statusBand.textContent = message;
}

function setBusy(isBusy: boolean): void {
  searchButton.disabled = isBusy;
  refreshButton.disabled = isBusy;
  prevButton.disabled = isBusy || offset === 0;
  nextButton.disabled = isBusy || !hasMore;
}

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
    const fallback = fallbackMessageFor(response.status);
    throw new Error(readErrorMessage(body) ?? fallback);
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

async function loadList(nextOffset = offset): Promise<void> {
  setBusy(true);
  setStatus('최근 결과를 불러오는 중입니다.');

  try {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(nextOffset) });
    const data = await fetchJson<ResultsListResponse>(`/api/results?${params}`);
    offset = data.offset;
    hasMore = data.hasMore;
    renderList(data.results);
    setStatus(data.results.length === 0
      ? '아직 업로드된 Supabase 결과가 없습니다. 오프라인 큐에만 있는 결과는 이 화면에 표시되지 않습니다.'
      : `${data.results.length}개 결과를 불러왔습니다.`);
  } catch (error) {
    renderList([]);
    setStatus(error instanceof Error ? error.message : '결과 목록을 불러오지 못했습니다.');
  } finally {
    setBusy(false);
  }
}

function renderList(results: ResultSummary[]): void {
  resultList.replaceChildren();

  if (results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'emptyState';
    empty.textContent = '표시할 결과가 없습니다.';
    resultList.append(empty);
    return;
  }

  for (const result of results) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = result.code === selectedCode ? 'resultButton isSelected' : 'resultButton';
    button.append(
      summaryCell('Code', result.code),
      summaryCell('Pattern', result.patternName),
      summaryCell('Issued', formatDate(result.issuedAt)),
      summaryCell('Assets', result.hasVideo && result.hasPoster ? 'video/poster' : 'partial'),
    );
    button.addEventListener('click', () => {
      selectedCode = result.code;
      codeSearch.value = result.code;
      void loadDetail(result.code);
      renderList(results);
    });
    resultList.append(button);
  }
}

function summaryCell(label: string, value: string): HTMLElement {
  const cell = document.createElement('div');
  const caption = document.createElement('span');
  const content = document.createElement('b');
  caption.textContent = label;
  content.textContent = value;
  cell.append(caption, content);
  return cell;
}

async function loadDetail(code: string): Promise<void> {
  const normalized = normalizeCode(code);
  if (!normalized) {
    setStatus('조회할 세션 코드를 입력하세요.');
    return;
  }

  setBusy(true);
  setStatus(`${normalized} 상세를 불러오는 중입니다.`);

  try {
    const params = new URLSearchParams({ code: normalized });
    const [data, ordersData] = await Promise.all([
      fetchJson<ResultDetailResponse>(`/api/results?${params}`),
      fetchJson<OrdersResponse>(`/api/orders?${params}`),
    ]);
    selectedCode = data.result.code;
    renderDetail(data.result, ordersData.orders);
    setStatus(`${data.result.code} 상세와 목업 주문 ${ordersData.orders.length}건을 불러왔습니다. 서명 URL은 ${formatDate(data.result.assetUrlExpiresAt)}까지 유효합니다.`);
  } catch (error) {
    renderEmptyDetail(error instanceof Error ? error.message : '상세 결과를 불러오지 못했습니다.');
    setStatus(error instanceof Error ? error.message : '상세 결과를 불러오지 못했습니다.');
  } finally {
    setBusy(false);
  }
}

async function searchDetailAndRefreshList(): Promise<void> {
  const normalized = normalizeCode(codeSearch.value);
  if (normalized) {
    await loadDetail(normalized);
  }

  await loadList(0);
}

function renderDetail(result: ResultDetail, orders: OrderSummary[]): void {
  detailContent.replaceChildren();

  if (result.posterUrl) {
    const posterFrame = document.createElement('div');
    const poster = document.createElement('img');
    posterFrame.className = 'posterFrame';
    poster.src = result.posterUrl;
    poster.alt = `${result.code} poster`;
    posterFrame.append(poster);
    detailContent.append(posterFrame);
  }

  const metaGrid = document.createElement('div');
  metaGrid.className = 'metaGrid';
  metaGrid.append(
    summaryCell('Code', result.code),
    summaryCell('Session', result.sessionId),
    summaryCell('Pattern', result.patternName),
    summaryCell('Issued', formatDate(result.issuedAt)),
  );

  const assetLinks = document.createElement('div');
  assetLinks.className = 'assetLinks';
  appendAssetLink(assetLinks, '비디오 열기', result.videoUrl);
  appendAssetLink(assetLinks, '포스터 열기', result.posterUrl);

  const tileMeta = document.createElement('pre');
  tileMeta.className = 'tileMeta';
  tileMeta.textContent = JSON.stringify(result.tileMeta, null, 2);

  detailContent.append(metaGrid, assetLinks, renderOrders(orders), tileMeta);
}

function renderOrders(orders: OrderSummary[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'ordersBlock';

  const heading = document.createElement('h3');
  heading.textContent = '목업 주문';
  section.append(heading);

  if (orders.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'emptyState emptyState--compact';
    empty.textContent = '이 결과 코드로 저장된 목업 주문이 없습니다.';
    section.append(empty);
    return section;
  }

  const list = document.createElement('div');
  list.className = 'ordersList';
  for (const order of orders) {
    const item = document.createElement('article');
    item.className = 'orderCard';
    item.append(
      summaryCell('Visitor', order.visitorName),
      summaryCell('Contact', order.contact),
      summaryCell('Option', productOptionLabel(order.productOption)),
      summaryCell('Created', formatDate(order.createdAt)),
    );
    list.append(item);
  }
  section.append(list);
  return section;
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

function renderEmptyDetail(message: string): void {
  detailContent.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'emptyState';
  empty.textContent = message;
  detailContent.append(empty);
}

function normalizeCode(value: string): string {
  return value.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
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

searchButton.addEventListener('click', () => void searchDetailAndRefreshList());
refreshButton.addEventListener('click', () => void loadList(0));
prevButton.addEventListener('click', () => void loadList(Math.max(0, offset - PAGE_LIMIT)));
nextButton.addEventListener('click', () => void loadList(offset + PAGE_LIMIT));
codeSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void searchDetailAndRefreshList();
  }
});
adminToken.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void loadList(0);
  }
});

setBusy(false);
setStatus('운영 토큰을 입력한 뒤 목록 새로고침 또는 상세 조회를 실행하세요.');
