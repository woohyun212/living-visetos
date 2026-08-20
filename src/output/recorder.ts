/** D · Recorder / Uploader / QR — 결과물 파이프라인 (F-05, ADR-005·007) */
import type { DeliveryTicket, ResultPackage, PatternTile } from '../contracts.ts';
import {
  enqueuePendingResult,
  startDeliveryRetryLoop,
  UploadError,
  type PendingResultEntry,
  type RetryLoopOptions,
} from './delivery-queue.ts';
import { PortraitComposer, PORTRAIT_HEIGHT, PORTRAIT_WIDTH, type PortraitSource } from './portrait.ts';

export const CLIP_SECONDS = 8;

const RESULT_UPLOAD_ENDPOINT = '/api/results';

/** 세로 캔버스를 뜨는 속도. 30fps 면 무대의 연출을 다 담고 8초 클립도 25MB 한도 안에 든다. */
const PORTRAIT_FPS = 30;
/*
 * timeslice 는 쓰지 않는다. mp4 muxer 에 timeslice 를 주면 init 조각 + 프래그먼트(fMP4)로
 * 쪼개져 나오는데, 그것을 이어 붙인 파일의 재생 보장은 이 자리에서 확인할 수 없다 —
 * ADR-007 이 mp4 를 앞세우는 이유가 바로 iOS 사파리이기 때문에 컨테이너를 바꾸지 않는다.
 * start() 한 번, stop() 에서 자기완결적 blob 한 장. 인코더 거부는 아래 네 갈래로 잡는다:
 *   생성 예외 · start() 예외 · 데이터 전 error 이벤트 · 데이터 없이 끝난 stop.
 */
/** 포스터를 PNG 로 유지할 상한(서버 RESULT_UPLOAD_MAX_POSTER_BYTES=2MB). 넘으면 JPEG 로 다시 뜬다. */
const POSTER_PNG_MAX_BYTES = 1_600_000;
const POSTER_JPEG_QUALITY = 0.9;

/*
 * 캔버스 스트림에는 오디오 트랙이 없다 — 오디오 코덱을 요구하는 후보는
 * isTypeSupported 를 통과해도 start() 에서 인코더 거부가 난다(w3 통합에서 실측).
 * 또 avc1.42E01E(레벨 3.0)는 1080×1920 을 담지 못한다. plain mp4 를 앞세워
 * 브라우저가 맞는 프로파일·레벨을 고르게 한다. (ADR-007: mp4 우선, webm 폴백)
 *
 * 지원 여부는 isTypeSupported 가 과보고할 수 있으므로 여기서 끝내지 않고,
 * 실제로 start() 가 받아들이고 데이터가 나오는 후보를 찾을 때까지 순회한다.
 */
export const RECORDER_MIME_TYPES = [
  'video/mp4',
  'video/mp4;codecs="h264"',
  'video/webm;codecs="vp9"',
  'video/webm;codecs="vp8"',
  'video/webm',
] as const;

/** 지원한다고 보고한 후보 + 마지막으로 브라우저 기본값(undefined). */
export function selectMimeCandidates(
  isSupported: (mimeType: string) => boolean,
): (string | undefined)[] {
  return [...RECORDER_MIME_TYPES.filter((mimeType) => isSupported(mimeType)), undefined];
}

export interface RecordOptions {
  sessionId: string;
  patternName: string;
  tileMeta: PatternTile['meta'];
  seconds?: number;
}

/** 무대와 같은 그림을 1080×1920 세로로 8초 녹화해 ResultPackage 로 묶는다. */
export async function record(
  source: PortraitSource,
  options: RecordOptions,
): Promise<ResultPackage> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not available in this browser.');
  }

  const seconds = options.seconds ?? CLIP_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Record duration must be a positive number of seconds.');
  }

  const composer = new PortraitComposer(source);
  if (typeof composer.canvas.captureStream !== 'function') {
    throw new Error('Canvas captureStream() is not available in this browser.');
  }

  composer.start();

  try {
    await composer.waitForFrame();

    const stream = composer.canvas.captureStream(PORTRAIT_FPS);
    try {
      const posterImage = await createPosterImage(composer.canvas);
      const video = await recordStream(stream, seconds);

      console.info(
        `[perf] record portrait=${PORTRAIT_WIDTH}x${PORTRAIT_HEIGHT} sec=${seconds} ` +
          `frames=${composer.frameCount} video=${video.type || 'unknown'}/${video.size}B ` +
          `poster=${posterImage.type}/${posterImage.size}B`,
      );

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
  } finally {
    composer.stop();
  }
}

/** 업로드 성공 시 url 티켓, 실패 시 로컬 큐에 넣고 세션 코드 티켓. */
export async function deliver(pkg: ResultPackage): Promise<DeliveryTicket> {
  const code = createSessionCode();

  try {
    const url = await uploadResultPackage(pkg, code);
    return { kind: 'url', url };
  } catch (error) {
    console.warn(`[delivery] 업로드 실패 — 재시도 큐에 적재합니다 code=${code}`, error);
    await enqueuePendingResult(pkg, code);
  }

  return { kind: 'code', code };
}

/**
 * 재시도 큐 소비를 켠다(앱 시작 시 1회). 해제 함수를 돌려준다.
 * 재전송은 **큐의 원래 코드**로 올라가므로 관객이 이미 받은 코드가 그대로 살아난다 —
 * 그래서 성공해도 화면은 조용하다(ADR-005).
 */
export function startDeliveryRetry(options?: RetryLoopOptions): () => void {
  return startDeliveryRetryLoop(uploadPendingResult, options);
}

function uploadResultPackage(pkg: ResultPackage, code: string): Promise<string> {
  return postResultForm(
    buildResultForm({
      sessionId: pkg.sessionId,
      code,
      certificate: pkg.certificate,
      video: pkg.video,
      posterImage: pkg.posterImage,
    }),
  );
}

function uploadPendingResult(entry: PendingResultEntry): Promise<string> {
  return postResultForm(
    buildResultForm({
      sessionId: entry.sessionId,
      code: entry.code,
      certificate: entry.certificate,
      video: entry.video,
      posterImage: entry.posterImage,
    }),
  );
}

function buildResultForm(input: {
  sessionId: string;
  code: string;
  certificate: ResultPackage['certificate'];
  video: Blob;
  posterImage: Blob;
}): FormData {
  const form = new FormData();
  form.set('sessionId', input.sessionId);
  form.set('code', input.code);
  form.set('certificate', JSON.stringify(input.certificate));
  form.set('video', input.video, `${input.sessionId}.${videoExtensionFor(input.video.type)}`);
  form.set(
    'posterImage',
    input.posterImage,
    `${input.sessionId}.${posterExtensionFor(input.posterImage.type)}`,
  );
  return form;
}

async function postResultForm(form: FormData): Promise<string> {
  let response: Response;
  try {
    response = await fetch(RESULT_UPLOAD_ENDPOINT, { method: 'POST', body: form });
  } catch (error) {
    // fetch 가 던졌다 = 네트워크 자체가 없다. 상태 없음 → 일시적 실패로 분류된다.
    throw new UploadError(
      error instanceof Error ? error.message : 'Result upload request failed.',
      null,
    );
  }

  if (!response.ok) {
    throw new UploadError(`Result upload failed with status ${response.status}.`, response.status);
  }

  const body = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (typeof body.url === 'string' && body.url.length > 0) {
    return body.url;
  }

  throw new UploadError('Result upload response did not include a url.', response.status);
}

type RecorderAttempt = {
  blob: Blob;
  mimeType: string;
  requested: string | undefined;
};

/** 인코더 협상 — 후보를 순회하며 실제로 데이터를 뱉는 첫 후보를 쓴다. */
async function recordStream(stream: MediaStream, seconds: number): Promise<Blob> {
  const candidates = selectMimeCandidates((mimeType) => MediaRecorder.isTypeSupported(mimeType));
  const failures: string[] = [];

  for (const [index, requested] of candidates.entries()) {
    try {
      const attempt = await runRecorder(stream, seconds, requested);
      console.info(
        `[perf] recorder mime=${attempt.mimeType} requested=${requested ?? 'browser-default'} ` +
          `attempt=${index + 1}/${candidates.length} bytes=${attempt.blob.size}` +
          (failures.length > 0 ? ` fallbacks=[${failures.join(' | ')}]` : ''),
      );
      return attempt.blob;
    } catch (error) {
      if (!(error instanceof RecorderAttemptError) || !error.recoverable) {
        throw error;
      }
      failures.push(`${requested ?? 'browser-default'}: ${error.message}`);
      console.warn(
        `[perf] recorder 후보 거부 mime=${requested ?? 'browser-default'} — 다음 후보로 폴백`,
        error.message,
      );
    }
  }

  throw new Error(`No encoder accepted the portrait stream. ${failures.join(' | ')}`);
}

class RecorderAttemptError extends Error {
  readonly recoverable: boolean;

  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = 'RecorderAttemptError';
    this.recoverable = recoverable;
  }
}

function runRecorder(
  stream: MediaStream,
  seconds: number,
  mimeType: string | undefined,
): Promise<RecorderAttempt> {
  return new Promise((resolve, reject) => {
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (error) {
      reject(
        new RecorderAttemptError(
          error instanceof Error ? error.message : 'MediaRecorder could not be created.',
          true,
        ),
      );
      return;
    }

    const chunks: Blob[] = [];
    let settled = false;
    let stopTimer = 0;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(stopTimer);
      callback();
    };

    /** 실패한 후보의 늦은 이벤트가 다음 후보로 새지 않도록 반드시 멈춘다. */
    const abort = (message: string, recoverable: boolean): void =>
      settle(() => {
        try {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          }
        } catch {
          // 이미 죽은 recorder — 무시한다.
        }
        reject(new RecorderAttemptError(message, recoverable));
      });

    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });

    recorder.addEventListener('error', (event) => {
      const recorderError = (event as Event & { error?: unknown }).error;
      const message = recorderError instanceof Error ? recorderError.message : 'MediaRecorder failed.';
      // 데이터가 이미 나온 뒤의 실패는 인코더 협상 문제가 아니다 — 폴백하지 않는다.
      abort(message, chunks.length === 0);
    });

    recorder.addEventListener('stop', () => {
      settle(() => {
        if (chunks.length === 0) {
          reject(new RecorderAttemptError('MediaRecorder produced no video data.', true));
          return;
        }

        const type = recorder.mimeType || chunks[0]?.type || 'video/webm';
        resolve({ blob: new Blob(chunks, { type }), mimeType: type, requested: mimeType });
      });
    });

    try {
      recorder.start();
    } catch (error) {
      abort(
        error instanceof Error ? error.message : 'MediaRecorder could not start.',
        true,
      );
      return;
    }

    stopTimer = globalThis.setTimeout(() => {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    }, seconds * 1000);
  });
}

/**
 * 포스터는 세로 합성 캔버스에서 그대로 뜬다(같은 그림, 같은 크롭).
 * 1080×1920 PNG 는 서버 한도(2MB)를 넘길 수 있어 그때만 JPEG 로 다시 뜬다 — 알파는 없다.
 */
async function createPosterImage(canvas: HTMLCanvasElement): Promise<Blob> {
  const png = await canvasToBlob(canvas, 'image/png');
  if (png.size <= POSTER_PNG_MAX_BYTES) {
    return png;
  }

  const jpeg = await canvasToBlob(canvas, 'image/jpeg', POSTER_JPEG_QUALITY);
  console.info(`[perf] poster png=${png.size}B → jpeg=${jpeg.size}B (2MB 업로드 한도)`);
  return jpeg;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        reject(new Error(`Canvas poster image could not be created (${type}).`));
      },
      type,
      quality,
    );
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

function posterExtensionFor(mimeType: string): string {
  return mimeType.includes('jpeg') ? 'jpg' : 'png';
}

function formatCode(value: string): string {
  return value.replace(/(.{4})(?=.)/g, '$1-');
}
