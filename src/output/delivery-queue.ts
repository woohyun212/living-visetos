/**
 * D · DeliveryQueue — 오프라인 재시도 큐 (ADR-005 "로컬 우선, 실패 시 세션 코드").
 *
 * 적재(IndexedDB: 영상·포스터 Blob 원본) + 인덱스(localStorage: 운영자가 눈으로 볼 수 있는 요약)
 * + 소비(앱 시작 / `online` / 60초 주기 재전송) + 24시간 만료 정리를 한곳에 모은다.
 *
 * 재전송은 **큐에 적힌 원래 코드 그대로** 올린다. 관객은 이미 그 코드를 들고 갔고
 * 조회 API(`GET /api/results?code=`)가 그 코드로 URL 을 돌려주기 때문에,
 * 코드가 바뀌면 관객이 든 종이가 죽는다. 그래서 재전송은 UI 를 건드리지 않고 조용히 끝난다.
 */
import type { ResultPackage } from '../contracts.ts';

const DELIVERY_QUEUE_KEY = 'living-visetos:delivery-queue:v1';
const DELIVERY_DB_NAME = 'living-visetos-delivery';
const DELIVERY_STORE_NAME = 'pending-results';
const DELIVERY_DB_VERSION = 1;

/** 큐 보관 한도 — 넘으면 관객이 이미 떠난 결과다(ADR-005 세션 코드 유효기간과 같은 24h). */
export const PENDING_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 주기 재전송 간격. 전시장 와이파이가 돌아오는 것을 눈치채는 최소 비용. */
export const RETRY_INTERVAL_MS = 60_000;

export type PendingResultEntry = {
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
  attempts: number;
  lastAttemptAt: string | null;
};

/** localStorage 인덱스 항목 — Blob 없이 운영자가 훑을 수 있는 요약. */
export type DeliveryQueueIndexEntry = {
  code: string;
  status: 'pending-upload';
  videoBytes: number;
  videoType: string | null;
  posterImageBytes: number;
  posterImageType: string | null;
  createdAt: string;
  expiresAt: string;
};

/** 업로드 실패를 상태 코드까지 들고 올라오게 한다 — 재시도/포기 판단의 근거. */
export class UploadError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

// ── 순수 함수 (테스트 대상) ──────────────────────────────

export function isExpired(entry: { expiresAt: string }, now: number = Date.now()): boolean {
  const at = Date.parse(entry.expiresAt);
  return Number.isFinite(at) ? at <= now : true;
}

export function pruneQueueIndex(
  entries: readonly DeliveryQueueIndexEntry[],
  now: number = Date.now(),
): DeliveryQueueIndexEntry[] {
  return entries.filter((entry) => !isExpired(entry, now));
}

export function removeFromQueueIndex(
  entries: readonly DeliveryQueueIndexEntry[],
  code: string,
): DeliveryQueueIndexEntry[] {
  return entries.filter((entry) => entry.code !== code);
}

/**
 * 일시적 실패(네트워크 끊김·5xx·429·408)만 큐에 남긴다.
 * 나머지 4xx 는 몇 번을 다시 올려도 같은 답이 오므로 큐 머리에서 영원히 막는 대신 버린다.
 */
export function isTransientUploadFailure(status: number | null): boolean {
  if (status === null) {
    return true; // fetch 자체가 던졌다 = 네트워크 문제
  }
  if (status === 408 || status === 429) {
    return true;
  }
  return status >= 500;
}

// ── IndexedDB ────────────────────────────────────────────

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
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => T,
): Promise<T> {
  const db = await openDeliveryDb();
  try {
    const transaction = db.transaction(DELIVERY_STORE_NAME, mode);
    const result = run(transaction.objectStore(DELIVERY_STORE_NAME));
    await transactionDone(transaction);
    return result;
  } finally {
    db.close();
  }
}

export async function putPendingResult(entry: PendingResultEntry): Promise<void> {
  await withStore('readwrite', (store) => {
    store.put(entry);
  });
}

export async function deletePendingResult(code: string): Promise<void> {
  await withStore('readwrite', (store) => {
    store.delete(code);
  });
}

export async function listPendingResults(): Promise<PendingResultEntry[]> {
  const entries: PendingResultEntry[] = [];
  await withStore('readonly', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      if (isPendingResultEntry(cursor.value)) {
        entries.push(cursor.value);
      }
      cursor.continue();
    };
  });

  // 오래된 것부터 — 관객이 먼저 떠난 순서대로 되살린다.
  return entries.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** 만료 항목을 IDB 에서 지우고, 지운 코드를 돌려준다. */
export async function pruneExpiredPendingResults(now: number = Date.now()): Promise<string[]> {
  const removed: string[] = [];
  await withStore('readwrite', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        return;
      }
      const value: unknown = cursor.value;
      if (isPendingResultEntry(value) && isExpired(value, now)) {
        removed.push(value.code);
        cursor.delete();
      }
      cursor.continue();
    };
  });
  return removed;
}

function isPendingResultEntry(value: unknown): value is PendingResultEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'string' &&
    'video' in value &&
    'posterImage' in value
  );
}

// ── localStorage 인덱스 ──────────────────────────────────

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null; // 프라이빗/키오스크 모드에서 접근 자체가 막힐 수 있다.
  }
}

export function readQueueIndex(): DeliveryQueueIndexEntry[] {
  const store = storage();
  if (!store) {
    return [];
  }

  try {
    const stored = store.getItem(DELIVERY_QUEUE_KEY);
    if (!stored) {
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter(isQueueIndexEntry) : [];
  } catch {
    return [];
  }
}

export function writeQueueIndex(entries: readonly DeliveryQueueIndexEntry[]): void {
  const store = storage();
  if (!store) {
    return;
  }

  try {
    store.setItem(DELIVERY_QUEUE_KEY, JSON.stringify(entries));
  } catch {
    // 로컬 우선 전달은 저장소 할당량·차단을 만나도 살아남아야 한다.
  }
}

function isQueueIndexEntry(value: unknown): value is DeliveryQueueIndexEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'expiresAt' in value &&
    typeof value.expiresAt === 'string'
  );
}

// ── 적재 ─────────────────────────────────────────────────

/** 업로드 실패 결과를 큐에 넣는다. IDB 가 막혀도 인덱스는 남긴다(운영자 안내용). */
export async function enqueuePendingResult(pkg: ResultPackage, code: string): Promise<void> {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PENDING_RESULT_TTL_MS).toISOString();

  const entry: PendingResultEntry = {
    code,
    sessionId: pkg.sessionId,
    certificate: pkg.certificate,
    video: pkg.video,
    posterImage: pkg.posterImage,
    videoType: pkg.video.type || null,
    posterImageType: pkg.posterImage.type || null,
    status: 'pending-upload',
    createdAt,
    expiresAt,
    attempts: 0,
    lastAttemptAt: null,
  };

  try {
    await pruneExpiredPendingResults(now);
    await putPendingResult(entry);
  } catch (error) {
    console.warn('[delivery] IndexedDB 적재 실패 — 세션 코드만 발급합니다', error);
  }

  const indexEntry: DeliveryQueueIndexEntry = {
    code,
    status: 'pending-upload',
    videoBytes: pkg.video.size,
    videoType: pkg.video.type || null,
    posterImageBytes: pkg.posterImage.size,
    posterImageType: pkg.posterImage.type || null,
    createdAt,
    expiresAt,
  };
  writeQueueIndex([...pruneQueueIndex(readQueueIndex(), now), indexEntry]);
}

// ── 소비 ─────────────────────────────────────────────────

export type PendingResultUploader = (entry: PendingResultEntry) => Promise<string>;

export interface RetryLoopOptions {
  intervalMs?: number;
  /** 테스트/디버그용 훅. UI 는 절대 건드리지 않는다(관객은 이미 코드를 들고 갔다). */
  onDelivered?: (code: string, url: string) => void;
}

/**
 * 앱 시작 + `online` + 주기(기본 60초)로 큐를 비운다. 해제 함수를 돌려준다.
 * 한 번에 하나씩 올리고, 일시적 실패를 만나면 그 자리에서 멈춘다 — 네트워크가
 * 죽은 상태에서 큐 전체를 헛돌리지 않기 위해서다(다음 틱이 이어받는다).
 */
export function startDeliveryRetryLoop(
  upload: PendingResultUploader,
  options: RetryLoopOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? RETRY_INTERVAL_MS;
  let flushing = false;
  let disposed = false;

  const flush = async (reason: string): Promise<void> => {
    if (flushing || disposed) {
      return;
    }
    flushing = true;

    try {
      await sweepExpired();

      if (globalThis.navigator?.onLine === false) {
        return;
      }

      const entries = await listPendingResults();
      for (const entry of entries) {
        if (disposed) {
          return;
        }

        try {
          const url = await upload(entry);
          await forget(entry.code);
          console.info(
            `[perf] delivery retry ok code=${entry.code} reason=${reason} bytes=${entry.video.size} url=${url}`,
          );
          options.onDelivered?.(entry.code, url);
        } catch (error) {
          const status = error instanceof UploadError ? error.status : null;
          if (!isTransientUploadFailure(status)) {
            await forget(entry.code);
            console.warn(
              `[delivery] 재전송 영구 실패 — 큐에서 제거 code=${entry.code} status=${status}`,
              error,
            );
            continue;
          }

          await markAttempt(entry);
          console.info(
            `[delivery] 재전송 보류 code=${entry.code} status=${status ?? 'offline'} reason=${reason}`,
          );
          return; // 네트워크가 아직이다 — 다음 틱에 이어서.
        }
      }
    } catch (error) {
      console.warn('[delivery] 재시도 큐 소비 실패', error);
    } finally {
      flushing = false;
    }
  };

  const onOnline = (): void => void flush('online');
  globalThis.addEventListener?.('online', onOnline);
  const timer = globalThis.setInterval(() => void flush('interval'), intervalMs);
  void flush('startup');

  return () => {
    disposed = true;
    globalThis.clearInterval(timer);
    globalThis.removeEventListener?.('online', onOnline);
  };
}

/** IDB 와 localStorage 인덱스에서 동시에 지운다 — 둘이 어긋나면 운영자가 유령을 본다. */
async function forget(code: string): Promise<void> {
  try {
    await deletePendingResult(code);
  } catch (error) {
    console.warn(`[delivery] IndexedDB 삭제 실패 code=${code}`, error);
  }
  writeQueueIndex(removeFromQueueIndex(readQueueIndex(), code));
}

async function markAttempt(entry: PendingResultEntry): Promise<void> {
  try {
    await putPendingResult({
      ...entry,
      attempts: (entry.attempts ?? 0) + 1, // 구버전(hotfix) 항목에는 이 칸이 없다
      lastAttemptAt: new Date().toISOString(),
    });
  } catch {
    // 시도 횟수는 운영 로그용 부가 정보다 — 못 남겨도 재전송 자체는 계속된다.
  }
}

/** 24시간 만료 정리 — IDB 를 먼저 비우고 인덱스를 같은 시각 기준으로 맞춘다. */
async function sweepExpired(now: number = Date.now()): Promise<void> {
  let removed: string[] = [];
  try {
    removed = await pruneExpiredPendingResults(now);
  } catch (error) {
    console.warn('[delivery] 만료 정리 실패', error);
  }

  const index = pruneQueueIndex(readQueueIndex(), now);
  const synced = removed.reduce<DeliveryQueueIndexEntry[]>(
    (entries, code) => removeFromQueueIndex(entries, code),
    index,
  );
  writeQueueIndex(synced);
}
