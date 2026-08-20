const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_RESULTS_BUCKET = env.SUPABASE_RESULTS_BUCKET ?? 'results';
const RESULT_PUBLIC_BASE_URL = env.RESULT_PUBLIC_BASE_URL;
const RESULT_ADMIN_TOKEN = env.RESULT_ADMIN_TOKEN;
const RESULT_ASSET_URL_TTL_SECONDS = parsePositiveInteger(
  env.RESULT_ASSET_URL_TTL_SECONDS,
  3600,
);
const RESULT_UPLOAD_MAX_VIDEO_BYTES = parsePositiveInteger(
  env.RESULT_UPLOAD_MAX_VIDEO_BYTES,
  25 * 1024 * 1024,
);
const RESULT_UPLOAD_MAX_POSTER_BYTES = parsePositiveInteger(
  env.RESULT_UPLOAD_MAX_POSTER_BYTES,
  2 * 1024 * 1024,
);

const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm']);
const POSTER_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const UPLOAD_RATE_LIMIT = 10;
const PUBLIC_RESULT_RATE_LIMIT = 60;
const ADMIN_RATE_LIMIT = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

type ResultRecord = {
  code: string;
  session_id: string;
  pattern_name: string;
  issued_at: string;
  tile_meta: unknown;
  video_path: string;
  poster_path: string;
};

type AdminResultSummary = {
  code: string;
  sessionId: string;
  patternName: string;
  issuedAt: string;
  hasVideo: boolean;
  hasPoster: boolean;
};

type AdminResultDetail = AdminResultSummary & {
  tileMeta: unknown;
  videoUrl: string | null;
  posterUrl: string | null;
  assetUrlExpiresAt: string;
};

type PublicResultDetail = {
  code: string;
  patternName: string;
  issuedAt: string;
  posterUrl: string | null;
  videoUrl: string | null;
  assetUrlExpiresAt: string;
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

  await sendNodeResponse(response, await handleRequest(toWebRequest(request, '/api/results')));
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request);
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
  }

  const uploadRateFailure = rateLimit(request, 'upload', UPLOAD_RATE_LIMIT);
  if (uploadRateFailure) {
    return uploadRateFailure;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESULT_PUBLIC_BASE_URL) {
    return json({ error: 'Result storage is not configured.' }, 503);
  }

  try {
    const form = await request.formData();
    const sessionId = requireText(form, 'sessionId');
    const code = requireText(form, 'code');
    const certificate = parseCertificate(requireText(form, 'certificate'));
    const video = requireFile(form, 'video', VIDEO_MIME_TYPES, RESULT_UPLOAD_MAX_VIDEO_BYTES);
    const posterImage = requireFile(
      form,
      'posterImage',
      POSTER_MIME_TYPES,
      RESULT_UPLOAD_MAX_POSTER_BYTES,
    );
    const safeCode = normalizeResultCode(code);
    if (!safeCode) {
      return json({ error: 'Missing result code.' }, 400);
    }
    const videoPath = `${safeCode}/clip.${extensionFor(video, 'webm')}`;
    const posterPath = `${safeCode}/poster.${extensionFor(posterImage, 'png')}`;

    await uploadToStorage(videoPath, video);
    await uploadToStorage(posterPath, posterImage);
    await insertResultRecord({
      code: safeCode,
      session_id: sessionId,
      pattern_name: certificate.patternName,
      issued_at: certificate.issuedAt,
      tile_meta: certificate.tileMeta,
      video_path: videoPath,
      poster_path: posterPath,
    });

    return json({ url: `${RESULT_PUBLIC_BASE_URL.replace(/\/$/, '')}/results/${safeCode}` }, 201);
  } catch (error) {
    return errorResponse(error, 'Result upload failed.', 400);
  }
}

async function handleGet(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const hasAuthorization = request.headers.has('authorization');

  if (code !== null && !hasAuthorization) {
    const publicRateFailure = rateLimit(request, 'public-result', PUBLIC_RESULT_RATE_LIMIT);
    if (publicRateFailure) {
      return publicRateFailure;
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Result storage is not configured.' }, 503, noStoreHeaders());
    }

    try {
      return await handlePublicDetail(code);
    } catch (error) {
      return errorResponse(error, 'Result lookup failed.', 400, noStoreHeaders());
    }
  }

  const adminRateFailure = rateLimit(request, 'admin-results', ADMIN_RATE_LIMIT);
  if (adminRateFailure) {
    return adminRateFailure;
  }

  const authFailure = authorizeAdminRequest(request);
  if (authFailure) {
    return authFailure;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Result storage is not configured.' }, 503);
  }

  try {
    if (code !== null) {
      return await handleDetail(code);
    }

    return await handleList(url.searchParams);
  } catch (error) {
    return errorResponse(error, 'Result lookup failed.', 400, noStoreHeaders());
  }
}

async function handlePublicDetail(code: string): Promise<Response> {
  const safeCode = normalizeResultCode(code);
  if (!safeCode) {
    return json({ error: 'Missing result code.' }, 400, noStoreHeaders());
  }

  const records = await selectResultRecords({ code: safeCode, limit: 1, offset: 0 });
  const record = records[0];
  if (!record) {
    return json({ error: 'Result not found.' }, 404, noStoreHeaders());
  }

  const result = await toPublicDetail(record);
  return json({ result }, 200, noStoreHeaders());
}

async function handleList(searchParams: URLSearchParams): Promise<Response> {
  const limit = clampInteger(searchParams.get('limit'), 20, 1, 100);
  const offset = clampInteger(searchParams.get('offset'), 0, 0, 10000);
  const records = await selectResultRecords({ limit: limit + 1, offset });
  const pageRecords = records.slice(0, limit);
  const results = pageRecords.map(toAdminSummary);

  return json({
    results,
    limit,
    offset,
    hasMore: records.length > limit,
  }, 200, noStoreHeaders());
}

async function handleDetail(code: string): Promise<Response> {
  const safeCode = normalizeResultCode(code);
  if (!safeCode) {
    return json({ error: 'Missing result code.' }, 400, noStoreHeaders());
  }

  const records = await selectResultRecords({ code: safeCode, limit: 1, offset: 0 });
  const record = records[0];
  if (!record) {
    return json({ error: 'Result not found.' }, 404, noStoreHeaders());
  }

  const result = await toAdminDetail(record);
  return json({ result }, 200, noStoreHeaders());
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

function authorizeAdminRequest(request: Request): Response | null {
  if (!RESULT_ADMIN_TOKEN) {
    return json({ error: 'Admin result access is not configured.' }, 503, noStoreHeaders());
  }

  const header = request.headers.get('authorization') ?? '';
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (token !== RESULT_ADMIN_TOKEN) {
    return json({ error: 'Admin authorization is required.' }, 401, {
      ...noStoreHeaders(),
      'WWW-Authenticate': 'Bearer realm="living-visetos-results"',
    });
  }

  return null;
}

async function selectResultRecords(options: {
  code?: string;
  limit: number;
  offset: number;
}): Promise<ResultRecord[]> {
  const { serviceKey, url } = requireSupabaseConfig();
  const searchParams = new URLSearchParams({
    select: 'code,session_id,pattern_name,issued_at,tile_meta,video_path,poster_path',
    order: 'issued_at.desc',
    limit: String(options.limit),
    offset: String(options.offset),
  });

  if (options.code) {
    searchParams.set('code', `eq.${options.code}`);
  }

  const response = await fetch(`${url}/rest/v1/results?${searchParams}`, {
    headers: {
      ...supabaseAuthHeaders(serviceKey),
      apikey: serviceKey,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new HttpError(await upstreamErrorMessage(response, 'Result record lookup failed.'), 502);
  }

  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new HttpError('Result record lookup returned an invalid payload.', 502);
  }

  return body.filter(isResultRecord);
}

function toAdminSummary(record: ResultRecord): AdminResultSummary {
  return {
    code: record.code,
    sessionId: record.session_id,
    patternName: record.pattern_name,
    issuedAt: record.issued_at,
    hasVideo: record.video_path.length > 0,
    hasPoster: record.poster_path.length > 0,
  };
}

async function toAdminDetail(record: ResultRecord): Promise<AdminResultDetail> {
  const expiresAt = new Date(Date.now() + RESULT_ASSET_URL_TTL_SECONDS * 1000).toISOString();
  const [videoUrl, posterUrl] = await Promise.all([
    signStorageObject(record.video_path),
    signStorageObject(record.poster_path),
  ]);

  return {
    ...toAdminSummary(record),
    tileMeta: record.tile_meta,
    videoUrl,
    posterUrl,
    assetUrlExpiresAt: expiresAt,
  };
}

async function toPublicDetail(record: ResultRecord): Promise<PublicResultDetail> {
  const expiresAt = new Date(Date.now() + RESULT_ASSET_URL_TTL_SECONDS * 1000).toISOString();
  const [posterUrl, videoUrl] = await Promise.all([
    signStorageObject(record.poster_path),
    signStorageObject(record.video_path),
  ]);

  return {
    code: record.code,
    patternName: record.pattern_name,
    issuedAt: record.issued_at,
    posterUrl,
    videoUrl,
    assetUrlExpiresAt: expiresAt,
  };
}

async function signStorageObject(path: string): Promise<string | null> {
  if (!path) {
    return null;
  }

  const { serviceKey, url } = requireSupabaseConfig();
  const response = await fetch(
    `${url}/storage/v1/object/sign/${SUPABASE_RESULTS_BUCKET}/${encodeURIComponentPath(path)}`,
    {
      method: 'POST',
      headers: {
        ...supabaseAuthHeaders(serviceKey),
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: RESULT_ASSET_URL_TTL_SECONDS }),
    },
  );

  if (!response.ok) {
    throw new HttpError(await upstreamErrorMessage(response, 'Storage signed URL failed.'), 502);
  }

  const body: unknown = await response.json();
  if (!isObject(body)) {
    throw new HttpError('Storage signed URL returned an invalid payload.', 502);
  }

  const signedUrl = body.signedURL ?? body.signedUrl;
  if (typeof signedUrl !== 'string' || signedUrl.length === 0) {
    throw new HttpError('Storage signed URL response did not include a URL.', 502);
  }

  return storageSignedUrl(signedUrl, url);
}

function storageSignedUrl(signedUrl: string, supabaseUrl: string): string {
  if (/^https?:\/\//i.test(signedUrl)) {
    return signedUrl;
  }

  const path = signedUrl.startsWith('/') ? signedUrl : `/${signedUrl}`;
  if (path.startsWith('/storage/v1/')) {
    return new URL(path, supabaseUrl).toString();
  }

  if (path.startsWith('/object/')) {
    return new URL(`/storage/v1${path}`, supabaseUrl).toString();
  }

  return new URL(path, supabaseUrl).toString();
}

function requireText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing form field: ${name}.`);
  }
  return value;
}

function requireFile(
  form: FormData,
  name: string,
  allowedMimeTypes: Set<string>,
  maxBytes: number,
): File {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`Missing file field: ${name}.`);
  }

  const mimeType = normalizedMimeType(value.type);
  if (!allowedMimeTypes.has(mimeType)) {
    throw new Error(`Unsupported file type for ${name}.`);
  }

  if (value.size > maxBytes) {
    throw new Error(`File too large for ${name}.`);
  }

  return value;
}

function parseCertificate(value: string): { patternName: string; issuedAt: string; tileMeta: unknown } {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) {
    throw new Error('Invalid certificate payload.');
  }

  const { patternName, issuedAt, tileMeta } = parsed;
  if (typeof patternName !== 'string' || typeof issuedAt !== 'string') {
    throw new Error('Invalid certificate fields.');
  }

  return { patternName, issuedAt, tileMeta };
}

async function uploadToStorage(path: string, file: File): Promise<void> {
  const { serviceKey, url } = requireSupabaseConfig();
  const response = await fetch(
    `${url}/storage/v1/object/${SUPABASE_RESULTS_BUCKET}/${encodeURIComponentPath(path)}`,
    {
      method: 'POST',
      headers: {
        ...supabaseAuthHeaders(serviceKey),
        apikey: serviceKey,
        'content-type': file.type || 'application/octet-stream',
      },
      body: file,
    },
  );

  if (!response.ok) {
    throw new HttpError(await upstreamErrorMessage(response, 'Storage upload failed.'), 502);
  }
}

async function insertResultRecord(record: ResultRecord): Promise<void> {
  const { serviceKey, url } = requireSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/results`, {
    method: 'POST',
    headers: {
      ...supabaseAuthHeaders(serviceKey),
      apikey: serviceKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(record),
  });

  if (!response.ok) {
    throw new HttpError(await upstreamErrorMessage(response, 'Result record insert failed.'), 502);
  }
}

function supabaseAuthHeaders(serviceKey: string): Record<string, string> {
  return serviceKey.startsWith('sb_secret_')
    ? {}
    : { authorization: `Bearer ${serviceKey}` };
}

async function upstreamErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '');
  const compactBody = body.replace(/\s+/g, ' ').trim().slice(0, 500);
  return compactBody
    ? `${fallback} Supabase ${response.status}: ${compactBody}`
    : `${fallback} Supabase ${response.status}.`;
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
    throw new Error('Result storage is not configured.');
  }

  const url = normalizeSupabaseUrl(SUPABASE_URL, 'Result');
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

function clampInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extensionFor(file: File, fallback: string): string {
  const mimeType = normalizedMimeType(file.type);
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'video/webm') return 'webm';
  return fallback;
}

function normalizedMimeType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function encodeURIComponentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isResultRecord(value: unknown): value is ResultRecord {
  return (
    isObject(value) &&
    typeof value.code === 'string' &&
    typeof value.session_id === 'string' &&
    typeof value.pattern_name === 'string' &&
    typeof value.issued_at === 'string' &&
    typeof value.video_path === 'string' &&
    typeof value.poster_path === 'string' &&
    'tile_meta' in value
  );
}
