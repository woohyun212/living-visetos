/**
 * D · 녹화 파이프라인 테스트 — DOM 없이 돌아야 하므로 순수 계산만 가져온다.
 *   1) 세로 cover 크롭 기하 (무대와 같은 그림인가)
 *   2) 인코더 후보 협상 순서 (mp4 우선 · 브라우저 기본값 마지막)
 *   3) 재시도 큐의 만료·인덱스 동기화·실패 분류
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PENDING_RESULT_TTL_MS,
  isExpired,
  isTransientUploadFailure,
  pruneQueueIndex,
  removeFromQueueIndex,
  type DeliveryQueueIndexEntry,
} from '../src/output/delivery-queue.ts';
import { RECORDER_MIME_TYPES, selectMimeCandidates } from '../src/output/recorder.ts';
import { PORTRAIT_HEIGHT, PORTRAIT_WIDTH, coverRect } from '../src/output/portrait.ts';

test('세로 캔버스는 contracts 의 1080×1920 이다', () => {
  assert.equal(PORTRAIT_WIDTH, 1080);
  assert.equal(PORTRAIT_HEIGHT, 1920);
});

test('cover 크롭은 짧은 쪽을 채우고 넘치는 쪽을 가운데서 잘라낸다', () => {
  // 960×720(4:3) 카메라 → 세로 무대: 높이를 채우고 좌우가 잘린다.
  const wide = coverRect(960, 720, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  assert.equal(Math.round(wide.dh), PORTRAIT_HEIGHT);
  assert.ok(wide.dw > PORTRAIT_WIDTH, '가로가 넘쳐야 잘라낼 것이 있다');
  assert.equal(wide.dy, 0);
  assert.equal(Math.round(wide.dx * 2 + wide.dw), PORTRAIT_WIDTH, '가운데 정렬');

  // 이미 세로로 더 긴 소스 → 가로를 채우고 위아래가 잘린다.
  const tall = coverRect(1080, 2400, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  assert.equal(Math.round(tall.dw), PORTRAIT_WIDTH);
  assert.ok(tall.dh > PORTRAIT_HEIGHT);
  assert.equal(tall.dx, 0);

  // 정확히 같은 비율이면 레터박스 없이 딱 맞는다.
  const exact = coverRect(540, 960, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
  assert.deepEqual(exact, { dx: 0, dy: 0, dw: PORTRAIT_WIDTH, dh: PORTRAIT_HEIGHT });
});

test('cover 크롭은 크기를 모르는 프레임에서도 캔버스를 채운다', () => {
  assert.deepEqual(coverRect(0, 0, PORTRAIT_WIDTH, PORTRAIT_HEIGHT), {
    dx: 0,
    dy: 0,
    dw: PORTRAIT_WIDTH,
    dh: PORTRAIT_HEIGHT,
  });
});

test('인코더 후보는 mp4 우선 · 지원 안 하는 후보는 빠지고 · 기본값이 마지막', () => {
  const all = selectMimeCandidates(() => true);
  assert.deepEqual(all, [...RECORDER_MIME_TYPES, undefined]);

  const webmOnly = selectMimeCandidates((mimeType) => mimeType.includes('webm'));
  assert.deepEqual(webmOnly, [
    'video/webm;codecs="vp9"',
    'video/webm;codecs="vp8"',
    'video/webm',
    undefined,
  ]);

  // 아무것도 지원하지 않는다고 해도 브라우저 기본값 한 번은 시도한다.
  assert.deepEqual(selectMimeCandidates(() => false), [undefined]);
});

test('오디오 코덱을 요구하는 후보는 목록에 없다 (캔버스 스트림에는 오디오 트랙이 없다)', () => {
  for (const mimeType of RECORDER_MIME_TYPES) {
    assert.ok(!/opus|aac|mp4a/i.test(mimeType), `${mimeType} 는 오디오 코덱을 요구한다`);
  }
});

const indexEntry = (code: string, expiresAt: string): DeliveryQueueIndexEntry => ({
  code,
  status: 'pending-upload',
  videoBytes: 1,
  videoType: 'video/mp4',
  posterImageBytes: 1,
  posterImageType: 'image/png',
  createdAt: new Date(0).toISOString(),
  expiresAt,
});

test('큐 항목은 24시간 뒤 만료된다', () => {
  const now = Date.parse('2026-08-21T00:00:00.000Z');
  const fresh = new Date(now + PENDING_RESULT_TTL_MS).toISOString();
  assert.equal(PENDING_RESULT_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(isExpired({ expiresAt: fresh }, now), false);
  assert.equal(isExpired({ expiresAt: new Date(now).toISOString() }, now), true);
  assert.equal(isExpired({ expiresAt: 'not-a-date' }, now), true, '깨진 값은 만료로 본다');
});

test('인덱스 동기화 — 만료·전송 성공 항목만 빠진다', () => {
  const now = Date.parse('2026-08-21T00:00:00.000Z');
  const alive = indexEntry('AAAA-BBBB', new Date(now + 1000).toISOString());
  const dead = indexEntry('CCCC-DDDD', new Date(now - 1000).toISOString());

  assert.deepEqual(pruneQueueIndex([alive, dead], now), [alive]);
  assert.deepEqual(removeFromQueueIndex([alive, dead], 'AAAA-BBBB'), [dead]);
  assert.deepEqual(removeFromQueueIndex([alive], 'NOPE-NOPE'), [alive]);
});

test('일시적 실패만 큐에 남는다 — 나머지 4xx 는 큐 머리를 막지 않는다', () => {
  assert.equal(isTransientUploadFailure(null), true, 'fetch 자체 실패 = 오프라인');
  assert.equal(isTransientUploadFailure(503), true);
  assert.equal(isTransientUploadFailure(500), true);
  assert.equal(isTransientUploadFailure(429), true);
  assert.equal(isTransientUploadFailure(408), true);
  assert.equal(isTransientUploadFailure(400), false);
  assert.equal(isTransientUploadFailure(413), false);
  assert.equal(isTransientUploadFailure(409), false);
});
