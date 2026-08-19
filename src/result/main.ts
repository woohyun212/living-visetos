import './style.css';

type PublicResultDetail = {
  code: string;
  patternName: string;
  issuedAt: string;
  posterUrl: string | null;
  videoUrl: string | null;
  assetUrlExpiresAt: string;
};

type ResultDetailResponse = {
  result: PublicResultDetail;
};

type OrderResponse = {
  orderId: string;
};

const getElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing result element: ${id}`);
  }
  return element as T;
};

const statusBand = getElement<HTMLElement>('statusBand');
const detailContent = getElement<HTMLElement>('detailContent');
const orderForm = getElement<HTMLFormElement>('orderForm');
const visitorName = getElement<HTMLInputElement>('visitorName');
const contact = getElement<HTMLInputElement>('contact');
const productOption = getElement<HTMLSelectElement>('productOption');
const consent = getElement<HTMLInputElement>('consent');
const submitButton = getElement<HTMLButtonElement>('submitButton');
const formStatus = getElement<HTMLElement>('formStatus');

let resultCode = normalizeCode(codeFromLocation());
let resultLoaded = false;

function setStatus(message: string): void {
  statusBand.textContent = message;
}

function setFormStatus(message: string): void {
  formStatus.textContent = message;
}

function setOrderDisabled(isDisabled: boolean): void {
  submitButton.disabled = isDisabled || !resultLoaded;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('결과 API가 JSON 응답을 반환하지 않았습니다.');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readErrorMessage(body) ?? `요청 실패: ${response.status}`);
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error('API 응답 형식이 올바르지 않습니다.');
  }

  return body as T;
}

function readErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null;
  }

  const error = (body as { error: unknown }).error;
  return typeof error === 'string' ? error : null;
}

async function loadResult(): Promise<void> {
  if (!resultCode) {
    renderEmptyDetail('URL에 결과 코드가 없습니다. /results/ABCD-1234 형식으로 다시 열어주세요.');
    setStatus('결과 코드가 없어 상세를 불러올 수 없습니다.');
    setOrderDisabled(true);
    return;
  }

  setOrderDisabled(true);
  setStatus(`${resultCode} 결과를 불러오는 중입니다.`);

  try {
    const params = new URLSearchParams({ code: resultCode });
    const data = await fetchJson<ResultDetailResponse>(`/api/results?${params}`);
    resultCode = data.result.code;
    resultLoaded = true;
    renderDetail(data.result);
    setStatus(`${data.result.code} 결과를 확인했습니다. 서명 URL은 ${formatDate(data.result.assetUrlExpiresAt)}까지 유효합니다.`);
  } catch (error) {
    resultLoaded = false;
    renderEmptyDetail(error instanceof Error ? error.message : '결과를 불러오지 못했습니다.');
    setStatus(error instanceof Error ? error.message : '결과를 불러오지 못했습니다.');
  } finally {
    setOrderDisabled(false);
  }
}

function renderDetail(result: PublicResultDetail): void {
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
    summaryCell('Pattern', result.patternName),
    summaryCell('Issued', formatDate(result.issuedAt)),
  );

  const assetLinks = document.createElement('div');
  assetLinks.className = 'assetLinks';
  appendAssetLink(assetLinks, '포스터 열기', result.posterUrl);
  appendAssetLink(assetLinks, '비디오 열기', result.videoUrl);

  detailContent.append(metaGrid, assetLinks);
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

async function submitOrder(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!resultLoaded || !resultCode) {
    setFormStatus('결과를 먼저 불러와야 목업 주문을 남길 수 있습니다.');
    return;
  }

  setOrderDisabled(true);
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
    setFormStatus(`목업 주문이 저장되었습니다. Order ID: ${data.orderId}`);
  } catch (error) {
    setFormStatus(error instanceof Error ? error.message : '목업 주문 저장에 실패했습니다.');
  } finally {
    setOrderDisabled(false);
  }
}

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

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

orderForm.addEventListener('submit', (event) => void submitOrder(event));
void loadResult();
