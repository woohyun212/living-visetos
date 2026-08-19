const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const RESULT_ADMIN_TOKEN = env.RESULT_ADMIN_TOKEN;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ORDER_RATE_LIMIT = 12;
const ADMIN_RATE_LIMIT = 60;
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

export const config = {
  runtime: 'nodejs',
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'GET') {
      return handleGet(request);
    }

    if (request.method === 'POST') {
      return handlePost(request);
    }

    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
  },
};

async function handlePost(request: Request): Promise<Response> {
  const orderRateFailure = rateLimit(request, 'order', ORDER_RATE_LIMIT);
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
    return errorResponse(error, 'Order submission failed.', 400, noStoreHeaders());
  }
}

async function handleGet(request: Request): Promise<Response> {
  const adminRateFailure = rateLimit(request, 'admin-orders', ADMIN_RATE_LIMIT);
  if (adminRateFailure) {
    return adminRateFailure;
  }

  const authFailure = authorizeAdminRequest(request);
  if (authFailure) {
    return authFailure;
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
    return errorResponse(error, 'Order lookup failed.', 400, noStoreHeaders());
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
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(record),
  });

  if (!response.ok) {
    throw new HttpError('Order record insert failed.', 502);
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
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new HttpError('Order record lookup failed.', 502);
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

function authorizeAdminRequest(request: Request): Response | null {
  if (!RESULT_ADMIN_TOKEN) {
    return json({ error: 'Admin order access is not configured.' }, 503, noStoreHeaders());
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (token !== RESULT_ADMIN_TOKEN) {
    return json({ error: 'Admin authorization is required.' }, 401, {
      ...noStoreHeaders(),
      'WWW-Authenticate': 'Bearer realm="living-visetos-orders"',
    });
  }

  return null;
}

function isValidContact(value: string): boolean {
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phone = /^\+?[0-9][0-9\s-]{7,18}[0-9]$/;
  return email.test(value) || phone.test(value);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function errorResponse(
  error: unknown,
  fallback: string,
  fallbackStatus: number,
  headers: Record<string, string> = {},
): Response {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status, headers);
  }

  const message = error instanceof Error ? error.message : fallback;
  return json({ error: message }, fallbackStatus, headers);
}

function noStoreHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store' };
}

function rateLimit(request: Request, scope: string, limit: number): Response | null {
  const now = Date.now();
  const key = `${scope}:${clientAddressFor(request)}`;
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
  return { serviceKey: SUPABASE_SERVICE_ROLE_KEY, url: SUPABASE_URL.replace(/\/$/, '') };
}

function normalizeResultCode(value: string): string {
  return value.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
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
