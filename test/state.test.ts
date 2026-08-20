/**
 * E · 상태머신 테스트 — 전이 표와 타임아웃 표가 서로 어긋나지 않는지 강제한다.
 * (DOM 없이 돌아야 하므로 state.ts 만 가져온다.)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { KioskState } from '../src/contracts.ts';
import {
  OWN_RESULT_VIEW_MS,
  SESSION_BUDGET_ITEMS,
  SESSION_BUDGET_MS,
  STATE_TIMEOUTS,
  StateMachine,
  TRANSITIONS,
  sessionBudgetTotalMs,
} from '../src/app/state.ts';

const ALL_STATES: KioskState[] = [
  'ATTRACT',
  'CONSENT',
  'CREATE',
  'TRANSFORM',
  'MATERIALIZE',
  'OWN',
  'RESET',
  'ERROR_RECOVER',
];

test('타임아웃 표의 next 는 전부 TRANSITIONS 의 간선이다', () => {
  for (const state of ALL_STATES) {
    const timeout = STATE_TIMEOUTS[state];
    if (!timeout) continue;
    assert.ok(
      TRANSITIONS[state].includes(timeout.next),
      `${state} 타임아웃이 허용되지 않은 전이(${timeout.next})를 노린다`,
    );
    assert.ok(timeout.ms > 0, `${state} 타임아웃이 0 이하다`);
  }
});

test('ATTRACT 만 무한 대기 — 나머지 상태는 전부 시한부다 (무인 운영)', () => {
  assert.equal(STATE_TIMEOUTS.ATTRACT, null);
  for (const state of ALL_STATES.filter((s) => s !== 'ATTRACT')) {
    assert.notEqual(STATE_TIMEOUTS[state], null, `${state} 에 타임아웃이 없다`);
  }
});

test('CONSENT 타임아웃은 ARCHITECTURE §4 대로 20초이고 ATTRACT 로 돌아간다', () => {
  assert.deepEqual(STATE_TIMEOUTS.CONSENT, { ms: 20_000, next: 'ATTRACT' });
});

test('세션 전체 시간 예산 ≤ 90초 (§8)', () => {
  const total = sessionBudgetTotalMs();
  assert.ok(
    total <= SESSION_BUDGET_MS,
    `세션 최악 시간 ${total}ms 가 예산 ${SESSION_BUDGET_MS}ms 를 넘는다`,
  );
  // 예산 항목이 실제 상수와 붙어 있는지 (표만 고치고 코드를 안 고치는 실수 방지)
  assert.ok(SESSION_BUDGET_ITEMS.some((item) => item.ms === OWN_RESULT_VIEW_MS));
});

test('모든 상태에서 나가는 간선이 하나 이상 있다 (막다른 상태 없음)', () => {
  for (const state of ALL_STATES) {
    assert.ok(TRANSITIONS[state].length > 0, `${state} 가 막다른 상태다`);
  }
});

test('허용되지 않은 전이는 무시되고 상태가 그대로다', () => {
  const machine = new StateMachine();
  machine.setTimeoutsEnabled(false);
  assert.equal(machine.state, 'ATTRACT');
  assert.equal(machine.to('OWN'), false);
  assert.equal(machine.state, 'ATTRACT');
  assert.equal(machine.to('CONSENT'), true);
  assert.equal(machine.state, 'CONSENT');
  machine.dispose();
});

test('정상 여정 ATTRACT→CONSENT→CREATE→TRANSFORM→MATERIALIZE→OWN→RESET→ATTRACT 가 전부 허용된다', () => {
  const machine = new StateMachine();
  machine.setTimeoutsEnabled(false);
  const journey: KioskState[] = [
    'CONSENT',
    'CREATE',
    'TRANSFORM',
    'MATERIALIZE',
    'OWN',
    'RESET',
    'ATTRACT',
  ];
  const seen: KioskState[] = [];
  machine.onChange((next) => seen.push(next));
  for (const state of journey) assert.equal(machine.to(state), true, `${state} 로 갈 수 없다`);
  assert.deepEqual(seen, journey);
  machine.dispose();
});

test('CONSENT 무응답 타임아웃이 ATTRACT 로 되돌린다 (시간 축소 검증)', async () => {
  const machine = new StateMachine();
  machine.to('CONSENT');
  // 20초를 실제로 기다리지 않는다 — rearm 으로 같은 경로를 짧게 재현.
  machine.rearm(30, 'ATTRACT');
  const reason = await new Promise<string>((resolve) => {
    machine.onChange((next, _prev, why) => next === 'ATTRACT' && resolve(why));
  });
  assert.equal(reason, 'timeout');
  assert.equal(machine.state, 'ATTRACT');
  machine.dispose();
});

test('pauseTimeout 은 타이머를 멈춘다 (녹화·업로드 중 세션이 끊기지 않게)', () => {
  const machine = new StateMachine();
  machine.to('CONSENT');
  assert.ok((machine.remainingMs ?? 0) > 0);
  machine.pauseTimeout();
  assert.equal(machine.remainingMs, null);
  machine.dispose();
});

test('타임아웃을 끄면(?debug=1) 타이머가 잡히지 않는다', () => {
  const machine = new StateMachine();
  machine.setTimeoutsEnabled(false);
  machine.to('CONSENT');
  assert.equal(machine.remainingMs, null);
  machine.rearm(10, 'ATTRACT');
  assert.equal(machine.remainingMs, null);
  machine.dispose();
});

test('forceTo 는 전이 표 밖이어도 통과시킨다 — 운영자 강제 RESET (§9)', () => {
  const machine = new StateMachine();
  machine.setTimeoutsEnabled(false);
  machine.to('CONSENT');
  machine.to('CREATE');

  // CREATE → RESET 은 표에 없다. 일반 경로는 막히고, 강제 경로만 통과한다.
  assert.equal(TRANSITIONS.CREATE.includes('RESET'), false);
  assert.equal(machine.to('RESET'), false);
  assert.equal(machine.state, 'CREATE');

  const seen: [KioskState, string][] = [];
  machine.onChange((next, _prev, reason) => seen.push([next, reason]));
  machine.forceTo('RESET');
  // 리스너가 불려야 RESET 진입의 에포크 증가·세션 파기가 그대로 일어난다.
  assert.deepEqual(seen, [['RESET', 'operator']]);
  assert.equal(machine.state, 'RESET');

  // 강제로 들어가도 RESET 은 표에 따라 ATTRACT 로 이어질 수 있다 (막다른 곳이 아니다).
  assert.equal(machine.to('ATTRACT'), true);
  machine.dispose();
});

test('강제 RESET 뒤에도 상태별 타임아웃 표가 그대로 걸린다', () => {
  const machine = new StateMachine();
  machine.to('CONSENT');
  machine.forceTo('RESET');
  const remaining = machine.remainingMs ?? 0;
  assert.ok(remaining > 0 && remaining <= STATE_TIMEOUTS.RESET!.ms);
  machine.dispose();
});
