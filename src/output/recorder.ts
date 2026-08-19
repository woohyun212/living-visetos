/** D · Recorder / Uploader / QR — 결과물 파이프라인 (F-05, ADR-005·007) */
import type { DeliveryTicket, PatternTile, ResultPackage } from '../contracts.ts';

export const CLIP_SECONDS = 8;

const DELIVERY_QUEUE_KEY = 'living-visetos:delivery-queue:v1';
const DELIVERY_DB_NAME = 'living-visetos-delivery';
const DELIVERY_STORE_NAME = 'pending-results';
const DELIVERY_DB_VERSION = 1;
const RESULT_UPLOAD_ENDPOINT = '/api/results';

const RECORDER_MIME_TYPES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1.42E01E"',
  'video/mp4;codecs="h264"',
  'video/mp4',
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="vp8,opus"',
  'video/webm;codecs="vp9"',
  'video/webm;codecs="vp8"',
  'video/webm',
];

export interface RecordOptions {
  sessionId: string;
  patternName: string;
  tileMeta: PatternTile['meta'];
  seconds?: number;
}

/** 렌더 캔버스를 8초 녹화해 ResultPackage 로 묶는다. */
export async function record(
  canvas: HTMLCanvasElement,
  options: RecordOptions,
): Promise<ResultPackage> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not available in this browser.');
  }

  if (typeof canvas.captureStream !== 'function') {
    throw new Error('Canvas captureStream() is not available in this browser.');
  }

  const seconds = options.seconds ?? CLIP_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Record duration must be a positive number of seconds.');
  }

  const stream = canvas.captureStream();

  try {
    const [video, posterImage] = await Promise.all([
      recordStream(stream, seconds),
      createPosterImage(canvas),
    ]);

    return {
      sessionId: options.sessionId,
      video,
      posterImage,
      certificate: {
        patternName: options.patternName,
        issuedAt: new Date().toISOString(),
        tileMeta: options.tileMeta,
      },
    };
  } finally {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

/** 업로드 성공 시 url 티켓, 실패 시 로컬 큐에 넣고 세션 코드 티켓. */
export async function deliver(pkg: ResultPackage): Promise<DeliveryTicket> {
  const code = createSessionCode();

  try {
    const url = await uploadResultPackage(pkg, code);
    return { kind: 'url', url };
  } catch {
    await enqueueForRetry(pkg, code);
  }

  return { kind: 'code', code };
}

function uploadResultPackage(pkg: ResultPackage, code: string): Promise<string> {
  const form = new FormData();
  form.set('sessionId', pkg.sessionId);
  form.set('code', code);
  form.set('certificate', JSON.stringify(pkg.certificate));
  form.set('video', pkg.video, `${pkg.sessionId}.${videoExtensionFor(pkg.video.type)}`);
  form.set('posterImage', pkg.posterImage, `${pkg.sessionId}.png`);

  return fetch(RESULT_UPLOAD_ENDPOINT, { method: 'POST', body: form })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Result upload failed with status ${response.status}.`);
      }
      return response.json() as Promise<{ url?: unknown }>;
    })
    .then((body) => {
      if (typeof body.url === 'string' && body.url.length > 0) {
        return body.url;
      }
      throw new Error('Result upload response did not include a url.');
    });
}

async function enqueueForRetry(pkg: ResultPackage, code: string): Promise<void> {
  const entry: PendingResultEntry = {
    code,
    sessionId: pkg.sessionId,
    certificate: pkg.certificate,
    video: pkg.video,
    posterImage: pkg.posterImage,
    videoType: pkg.video.type || null,
    posterImageType: pkg.posterImage.type || null,
    status: 'pending-upload',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  try {
    await putPendingResult(entry);
  } catch {
    // IndexedDB can be blocked in kiosk/private modes; keep a minimal debug breadcrumb.
  }

  try {
    const entry = {
      code,
      status: 'pending-upload',
      videoBytes: pkg.video.size,
      videoType: pkg.video.type || null,
      posterImageBytes: pkg.posterImage.size,
      posterImageType: pkg.posterImage.type || null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    const storage = globalThis.localStorage;
    const queue = readDeliveryQueue(storage).filter((item) => !isExpired(item));
    storage.setItem(DELIVERY_QUEUE_KEY, JSON.stringify([...queue, entry]));
  } catch {
    // Local-first delivery must survive private mode, quota, or blocked storage.
  }
}

function openDeliveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }

    const request = indexedDB.open(DELIVERY_DB_NAME, DELIVERY_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DELIVERY_STORE_NAME)) {
        db.createObjectStore(DELIVERY_STORE_NAME, { keyPath: 'code' });
      }
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function putPendingResult(entry: PendingResultEntry): Promise<void> {
  const db = await openDeliveryDb();
  try {
    const transaction = db.transaction(DELIVERY_STORE_NAME, 'readwrite');
    transaction.objectStore(DELIVERY_STORE_NAME).put(entry);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

function recordStream(stream: MediaStream, seconds: number): Promise<Blob> {
  const recorder = createMediaRecorder(stream);
  const chunks: Blob[] = [];

  return new Promise((resolve, reject) => {
    let stopTimer = 0;
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(stopTimer);
      callback();
    };

    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener('error', (event) => {
      const recorderError = (event as Event & { error?: unknown }).error;
      const message = recorderError instanceof Error ? recorderError.message : 'MediaRecorder failed.';
      settle(() => reject(new Error(message)));
    });

    recorder.addEventListener('stop', () => {
      settle(() => {
        if (chunks.length === 0) {
          reject(new Error('MediaRecorder produced no video data.'));
          return;
        }

        resolve(new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'video/webm' }));
      });
    });

    try {
      recorder.start();
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error('MediaRecorder could not start.')));
      return;
    }

    stopTimer = globalThis.setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }, seconds * 1000);
  });
}

function createMediaRecorder(stream: MediaStream): MediaRecorder {
  for (const mimeType of RECORDER_MIME_TYPES) {
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      continue;
    }

    try {
      return new MediaRecorder(stream, { mimeType });
    } catch {
      // Some browsers over-report support; keep walking toward default construction.
    }
  }

  try {
    return new MediaRecorder(stream);
  } catch (error) {
    throw error instanceof Error ? error : new Error('MediaRecorder could not be created.');
  }
}

function createPosterImage(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error('Canvas poster image could not be created.'));
    }, 'image/png');
  });
}

function createSessionCode(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const value = Array.from(bytes, (byte) => (byte % 36).toString(36).toUpperCase()).join('');
  return formatCode(value);
}

function videoExtensionFor(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm';
}

type PendingResultEntry = {
  code: string;
  sessionId: string;
  certificate: ResultPackage['certificate'];
  video: Blob;
  posterImage: Blob;
  videoType: string | null;
  posterImageType: string | null;
  status: 'pending-upload';
  createdAt: string;
  expiresAt: string;
};

function formatCode(value: string): string {
  return value.replace(/(.{4})(?=.)/g, '$1-');
}

type DeliveryQueueEntry = {
  code: string;
  expiresAt: string;
};

function readDeliveryQueue(storage: Storage): DeliveryQueueEntry[] {
  const stored = storage.getItem(DELIVERY_QUEUE_KEY);
  if (!stored) {
    return [];
  }

  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(isDeliveryQueueEntry);
}

function isDeliveryQueueEntry(value: unknown): value is DeliveryQueueEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'string'
  );
}

function isExpired(entry: DeliveryQueueEntry): boolean {
  return Date.parse(entry.expiresAt) <= Date.now();
}
