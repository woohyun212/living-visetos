const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const RESULT_ADMIN_TOKEN = env.RESULT_ADMIN_TOKEN;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/*
 * results.ts 와 같은 버킷 원칙: 공개 주문 · 미인증 · 운영을 분리하고
 * 운영 버킷만 토큰으로 키를 잡는다. 전시장 단일 NAT 에서 관객이 운영을 잠그면 안 된다.
 */
const ORDER_RATE_LIMIT = parsePositiveInteger(env.ORDER_RATE_LIMIT, 12);
const UNAUTH_RATE_LIMIT = parsePositiveInteger(env.RESULT_UNAUTH_RATE_LIMIT, 30);
const ADMIN_RATE_LIMIT = parsePositiveInteger(env.RESULT_ADMIN_RATE_LIMIT, 120);
const MAX_NAME_LENGTH = 40;
const MAX_CONTACT_LENGTH = 80;
const MAX_PRODUCT_OPTION_LENGTH = 80;
const ORDER_PRODUCT_OPTIONS = new Set(['classic-tote', 'mini-tote', 'flat-pouch']);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

type OrderRecord = {
  id: string;
  result_code: string;
  visitor_name: string;
  contact: string;
  product_option: string;
  consent: boolean;
  created_at: string;
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

type NodeApiRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  readable?: boolean;
};

type NodeApiResponse = {
  statusCode: number;
  setHeader(key: string, value: string): void;
  end(body: string): void;
};

export const config = {
  runtime: 'nodejs',
};

/*
 * Vercel Node 런타임의 Web Handler 규약(메서드별 named export).
 * https://vercel.com/docs/functions/functions-api-reference#function-signature
 * 아래 default export 는 Vite 로컬 미들웨어(Web Request 1-인자 호출)와
 * Vercel Node `(req, res)` 호출을 함께 받는 호환 진입점이라 함께 유지한다.
 */
export function GET(request: Request): Promise<Response> {
  return handleRequest(request);
}

export function POST(request: Request): Promise<Response> {
  return handleRequest(request);
}

export default async function handler(
  request: Request | NodeApiRequest,
  response?: NodeApiResponse,
): Promise<Response | undefined> {
  if (request instanceof Request) {
    return handleRequest(request);
  }

  if (!response) {
    throw new Error('Node response is required.');
  }

  await sendNodeResponse(response, await handleRequest(toWebRequest(request, '/api/orders')));
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request);
  }

  if (request.method === 'POST') {
    return handlePost(request);
  }

  return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
}

async function handlePost(request: Request): Promise<Response> {
  const orderRateFailure = rateLimit(addressRateKey(request, 'public-order'), ORDER_RATE_LIMIT);
  if (orderRateFailure) {
    return orderRateFailure;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Order storage is not configured.' }, 503, noStoreHeaders());
  }

  try {
    const payload = await readJsonObject(request);
    const record = parseOrderPayload(payload);
    const inserted = await insertOrderRecord(record);
    return json({ orderId: inserted.id }, 201, noStoreHeaders());
  } catch (error) {
    return errorResponse(error, 'Order submission failed.', 400, noStoreHeaders(), false);
  }
}

async function handleGet(request: Request): Promise<Response> {
  /*
   * 인증 검사가 먼저다. 예전 순서에서는 토큰 없는 GET 이 운영 버킷을 소모해
   * 관객/스캐너 트래픽만으로 운영자가 429 로 잠길 수 있었다(PR#5 P1-2).
   */
  const guard = adminGuard(request);
  if (!guard.ok) {
    const unauthFailure = rateLimit(addressRateKey(request, 'unauth-orders'), UNAUTH_RATE_LIMIT);
    return unauthFailure ?? guard.response;
  }

  const adminRateFailure = rateLimit(adminRateKey(guard.token), ADMIN_RATE_LIMIT);
  if (adminRateFailure) {
    return adminRateFailure;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Order storage is not configured.' }, 503, noStoreHeaders());
  }

  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const safeCode = code === null ? null : normalizeResultCode(code);
    if (code !== null && !safeCode) {
      return json({ error: 'Missing result code.' }, 400, noStoreHeaders());
    }

    const limit = clampInteger(url.searchParams.get('limit'), 50, 1, 100);
    const records = await selectOrderRecords({ code: safeCode, limit });
    return json({ orders: records.map(toOrderSummary) }, 200, noStoreHeaders());
  } catch (error) {
    return errorResponse(error, 'Order lookup failed.', 400, noStoreHeaders(), true);
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new HttpError('Order requests must use application/json.', 415);
  }

  const payload: unknown = await request.json().catch(() => null);
  if (!isObject(payload)) {
    throw new Error('Invalid order payload.');
  }

  return payload;
}

function parseOrderPayload(payload: Record<string, unknown>): Omit<OrderRecord, 'id'> {
  const resultCode = normalizeResultCode(requireString(payload, 'resultCode', 32));
  if (!resultCode) {
    throw new Error('Missing result code.');
  }

  const visitorName = requireString(payload, 'visitorName', MAX_NAME_LENGTH);
  const contact = requireString(payload, 'contact', MAX_CONTACT_LENGTH);
  const productOption = requireString(payload, 'productOption', MAX_PRODUCT_OPTION_LENGTH);
  const consent = payload.consent === true;

  if (!isValidContact(contact)) {
    throw new Error('Contact must be a valid email address or phone number.');
  }

  if (!ORDER_PRODUCT_OPTIONS.has(productOption)) {
    throw new Error('Invalid product option.');
  }

  if (!consent) {
    throw new Error('Consent is required for the demo order.');
  }

  return {
    result_code: resultCode,
    visitor_name: visitorName,
    contact,
    product_option: productOption,
    consent,
    created_at: new Date().toISOString(),
  };
}

function requireString(payload: Record<string, unknown>, field: string, maxLength: number): string {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new Error(`Missing order field: ${field}.`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Missing order field: ${field}.`);
  }

  if (trimmed.length > maxLength) {
    throw new Error(`Order field too long: ${field}.`);
  }

  return trimmed;
}

async function insertOrderRecord(record: Omit<OrderRecord, 'id'>): Promise<OrderRecord> {
  const { serviceKey, url } = requireSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      ...supabaseAuthHeaders(serviceKey),
      apikey: serviceKey,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(record),
  });

  if (!response.ok) {
    throw await upstreamFailure(response, 'Order record insert failed.', 502);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body) || !isOrderRecord(body[0])) {
    throw new HttpError('Order record insert returned an invalid payload.', 502);
  }

  return body[0];
}

async function selectOrderRecords(options: { code: string | null; limit: number }): Promise<OrderRecord[]> {
  const { serviceKey, url } = requireSupabaseConfig();
  const searchParams = new URLSearchParams({
    select: 'id,result_code,visitor_name,contact,product_option,consent,created_at',
    order: 'created_at.desc',
    limit: String(options.limit),
  });

  if (options.code) {
    searchParams.set('result_code', `eq.${options.code}`);
  }

  const response = await fetch(`${url}/rest/v1/orders?${searchParams}`, {
    headers: {
      ...supabaseAuthHeaders(serviceKey),
      apikey: serviceKey,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw await upstreamFailure(response, 'Order record lookup failed.', 502);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new HttpError('Order record lookup returned an invalid payload.', 502);
  }

  return body.filter(isOrderRecord);
}

function toOrderSummary(record: OrderRecord): OrderSummary {
  return {
    id: record.id,
    resultCode: record.result_code,
    visitorName: record.visitor_name,
    contact: record.contact,
    productOption: record.product_option,
    consent: record.consent,
    createdAt: record.created_at,
  };
}

type AdminGuard =
  | { ok: true; token: string }
  | { ok: false; response: Response };

function adminGuard(request: Request): AdminGuard {
  if (!RESULT_ADMIN_TOKEN) {
    return {
      ok: false,
      response: json({ error: 'Admin order access is not configured.' }, 503, noStoreHeaders()),
    };
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  if (!timingSafeEqual(token, RESULT_ADMIN_TOKEN)) {
    return {
      ok: false,
      response: json({ error: 'Admin authorization is required.' }, 401, {
        ...noStoreHeaders(),
        'WWW-Authenticate': 'Bearer realm="living-visetos-orders"',
      }),
    };
  }

  return { ok: true, token };
}

/** 토큰 비교에서 일치 길이가 응답 시간으로 새지 않게 한다. */
function timingSafeEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function isValidContact(value: string): boolean {
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phone = /^\+?[0-9][0-9\s-]{7,18}[0-9]$/;
  return email.test(value) || phone.test(value);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function toWebRequest(request: NodeApiRequest, fallbackPath: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = request.method ?? 'GET';
  const host = headers.get('host') ?? 'localhost';
  const protocol = headers.get('x-forwarded-proto') ?? 'https';
  const url = new URL(request.url ?? fallbackPath, `${protocol}://${host}`).toString();
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { headers, method });
  }

  return new Request(url, {
    body: request.readable === false ? null : request as unknown as BodyInit,
    duplex: 'half',
    headers,
    method,
  } as RequestInit & { duplex: 'half' });
}

async function sendNodeResponse(response: NodeApiResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(await webResponse.text());
}

function supabaseAuthHeaders(serviceKey: string): Record<string, string> {
  return serviceKey.startsWith('sb_secret_')
    ? {}
    : { authorization: `Bearer ${serviceKey}` };
}

/*
 * Supabase 응답 본문은 테이블/컬럼/제약 이름을 그대로 흘린다. 무인증 경로에는
 * 절대 실어 보내지 않고 detail 로만 분리해 서버 로그에 남긴다(PR#5 P2).
 */
async function upstreamFailure(
  response: Response,
  message: string,
  status: number,
): Promise<HttpError> {
  const body = await response.text().catch(() => '');
  const compactBody = body.replace(/\s+/g, ' ').trim().slice(0, 500);
  const detail = compactBody
    ? `Supabase ${response.status}: ${compactBody}`
    : `Supabase ${response.status}.`;
  return new HttpError(message, status, detail);
}

class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message);
  }
}

function errorResponse(
  error: unknown,
  fallback: string,
  fallbackStatus: number,
  headers: Record<string, string> = {},
  exposeDetail = false,
): Response {
  if (error instanceof HttpError) {
    if (error.detail) {
      console.error('[api/orders]', error.message, error.detail);
    }

    const message = exposeDetail && error.detail
      ? `${error.message} ${error.detail}`
      : error.message;
    return json({ error: message }, error.status, headers);
  }

  const message = error instanceof Error ? error.message : fallback;
  return json({ error: message }, fallbackStatus, headers);
}

function noStoreHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store' };
}

function rateLimit(key: string, limit: number): Response | null {
  const now = Date.now();
  const current = rateBuckets.get(key);

  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return null;
  }

  current.count += 1;
  if (current.count <= limit) {
    return null;
  }

  return json({ error: 'Too many requests.' }, 429, {
    ...noStoreHeaders(),
    'Retry-After': String(Math.ceil((current.resetAt - now) / 1000)),
  });
}

function addressRateKey(request: Request, scope: string): string {
  return `${scope}:${clientAddressFor(request)}`;
}

/** 운영 버킷은 IP 가 아니라 토큰으로 잡는다 — 관객과 같은 NAT 를 써도 분리된다. */
function adminRateKey(token: string): string {
  return `admin:${bucketFingerprint(token)}`;
}

function bucketFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function clientAddressFor(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

function requireSupabaseConfig(): { serviceKey: string; url: string } {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Order storage is not configured.');
  }

  const url = normalizeSupabaseUrl(SUPABASE_URL, 'Order');
  return { serviceKey: SUPABASE_SERVICE_ROLE_KEY, url };
}

function normalizeSupabaseUrl(value: string, scope: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${scope} storage SUPABASE_URL must be a valid project URL.`);
  }

  if (url.hostname === 'supabase.com' || url.pathname.includes('/dashboard')) {
    throw new Error(`${scope} storage SUPABASE_URL must be the Project URL like https://PROJECT_REF.supabase.co, not the dashboard URL.`);
  }

  return url.origin;
}

function normalizeResultCode(value: string): string {
  return value.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOrderRecord(value: unknown): value is OrderRecord {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.result_code === 'string' &&
    typeof value.visitor_name === 'string' &&
    typeof value.contact === 'string' &&
    typeof value.product_option === 'string' &&
    typeof value.consent === 'boolean' &&
    typeof value.created_at === 'string'
  );
}
