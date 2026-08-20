// 자체 서버(단일 VM) 프로덕션 호스트.
// Vercel 대신 Node 내장 http 로 (a) dist/ 정적 서빙 (b) /results/:code -> result.html 리라이트
// (c) /api/results·/api/orders 를 api/*.ts 웹 표준 핸들러로 위임한다.
// api/*.ts 는 --experimental-transform-types 로 직접 로드하므로 별도 번들 단계가 없다.
// (strip-only 모드는 api 가 쓰는 생성자 파라미터 프로퍼티를 처리하지 못한다.)
// 어댑터(toWebRequest/sendWebResponse) 로직은 vite.config.ts 의 로컬 미들웨어에서 이식했다.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const DIST_ROOT = resolve(process.env.LIVING_VISETOS_DIST ?? join(ROOT, 'dist'));
const PORT = Number.parseInt(process.env.PORT ?? '80', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// 업로드 상한(api/results.ts 기본값 25MB video + 2MB poster)에 multipart 오버헤드 여유를 더한 값.
const MAX_BODY_BYTES = parsePositiveInteger(process.env.MAX_REQUEST_BODY_BYTES, 32 * 1024 * 1024);

const MIME_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  // MediaPipe 런타임: application/wasm 이 아니면 instantiateStreaming 이 거부한다.
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
}));

// 부팅 시점에 한 번만 로드한다. 모듈이 깨졌으면 첫 키오스크 업로드에서 500 이 아니라
// 여기서 즉시 죽어 systemd 가 드러내도록 한다.
const resultsApi = (await import('./api/results.ts')).default;
const ordersApi = (await import('./api/orders.ts')).default;

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    sendFailure(response, 'Request handling failed.', error);
  });
});

async function handle(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (isApiRoute(pathname, '/api/results')) {
    return delegate(request, response, url, resultsApi, 'Local results API failed.');
  }

  if (isApiRoute(pathname, '/api/orders')) {
    return delegate(request, response, url, ordersApi, 'Local orders API failed.');
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.statusCode = 405;
    response.setHeader('allow', 'GET, HEAD');
    response.end('Method Not Allowed');
    return;
  }

  // vite.config.ts 와 동일한 리라이트 범위: /results 와 /results/* 모두 result.html 로 보낸다.
  if (pathname === '/results' || pathname.startsWith('/results/')) {
    return sendStatic(request, response, join(DIST_ROOT, 'result.html'));
  }

  return sendStaticPath(request, response, pathname);
}

function isApiRoute(pathname, base) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

async function delegate(request, response, url, api, fallbackMessage) {
  try {
    const webRequest = await toWebRequest(request, url);
    await sendWebResponse(response, await api(webRequest));
  } catch (error) {
    sendFailure(response, fallbackMessage, error);
  }
}

async function toWebRequest(request, url) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = request.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { headers, method });
  }

  // 스트리밍(duplex: 'half') 대신 버퍼링한다. 업로드 상한이 작고, 버퍼 본문을 붙이면
  // undici 가 프레이밍 헤더를 다시 계산하므로 원본 값은 지워야 formData() 가 깨지지 않는다.
  const body = await readBody(request);
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  return new Request(url, { body, headers, method });
}

function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let received = 0;

    request.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        rejectPromise(new HttpFailure('Request body too large.', 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', rejectPromise);
  });
}

async function sendWebResponse(response, webResponse) {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function sendStaticPath(request, response, pathname) {
  const decoded = safeDecode(pathname);
  if (decoded === null) {
    return sendPlain(response, 400, 'Bad Request');
  }

  const relative = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(join(DIST_ROOT, relative));

  // 경로 탈출 방지: 해석된 경로가 dist 루트 안에 있어야 한다.
  if (target !== DIST_ROOT && !target.startsWith(DIST_ROOT + sep)) {
    return sendPlain(response, 403, 'Forbidden');
  }

  const file = decoded.endsWith('/') ? join(target, 'index.html') : target;
  return sendStatic(request, response, file);
}

async function sendStatic(request, response, filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendPlain(response, 404, 'Not Found');
  }

  if (info.isDirectory()) {
    return sendStatic(request, response, join(filePath, 'index.html'));
  }

  const extension = extname(filePath).toLowerCase();
  response.statusCode = 200;
  response.setHeader('content-type', MIME_TYPES.get(extension) ?? 'application/octet-stream');
  response.setHeader('content-length', String(info.size));
  response.setHeader('last-modified', info.mtime.toUTCString());
  // 콘텐츠 해시가 붙는 것은 vite 산출물인 dist/assets/* 뿐이다.
  // wasm·models·glb·woff2 는 public/ 에서 그대로 복사돼 파일명이 고정이라
  // immutable 을 걸면 MediaPipe/모델을 갱신해도 브라우저가 옛 사본을 계속 쓴다.
  const isHashedAsset = filePath.startsWith(join(DIST_ROOT, 'assets') + sep);
  response.setHeader(
    'cache-control',
    extension === '.html'
      ? 'no-cache'
      : isHashedAsset
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  );

  // 파일명이 고정인 대용량 런타임(wasm 34MB)은 조건부 요청으로 재다운로드를 피한다.
  const ifModifiedSince = request.headers['if-modified-since'];
  if (ifModifiedSince && Date.parse(ifModifiedSince) >= Math.floor(info.mtimeMs / 1000) * 1000) {
    response.statusCode = 304;
    response.removeHeader('content-length');
    response.end();
    return;
  }

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function sendPlain(response, status, message) {
  response.statusCode = status;
  response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.end(message);
}

function sendFailure(response, fallback, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const status = error instanceof HttpFailure ? error.status : 500;
  const detail = error instanceof Error ? error.message : fallback;
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: fallback, detail }));
}

class HttpFailure extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`living-visetos listening on ${HOST}:${PORT} (dist: ${DIST_ROOT})`);
});
