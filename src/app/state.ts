/**
 * E · StateMachine (ARCHITECTURE §4 상태 다이어그램을 표로 옮긴 것)
 *
 * 전이 표 + 상태별 타임아웃을 **한 곳**에서 관리한다. 무인 키오스크이므로
 * "관객이 사라진 화면"이 영원히 남지 않는 것이 이 파일의 존재 이유다.
 *
 * 여정 배선(어떤 상태에서 어떤 모듈을 부를지)은 app/kiosk.ts 가 담당한다.
 * 이 파일은 상태·시간만 안다 — 모듈도, DOM 도 모른다.
 */
import type { KioskState } from '../contracts.ts';

/** ARCHITECTURE §4 그대로. 여기에 없는 전이는 버그다. */
export const TRANSITIONS: Record<KioskState, KioskState[]> = {
  ATTRACT: ['CONSENT'],
  CONSENT: ['CREATE', 'ATTRACT'], // 거절/20초 무응답 → ATTRACT
  CREATE: ['TRANSFORM', 'ERROR_RECOVER'], // FeatureSeed 확정 / 카메라·추출 실패
  TRANSFORM: ['MATERIALIZE'], // 타일 적용 완료
  MATERIALIZE: ['OWN'], // 이름 짓기 완료
  OWN: ['RESET'], // 전송/응모/이탈
  RESET: ['ATTRACT'], // 세션 파기
  ERROR_RECOVER: ['ATTRACT'], // 목 시드로 안내 후 리셋
};

export interface StateTimeout {
  /** 이 상태에 머무를 수 있는 최대 시간(ms) */
  readonly ms: number;
  /** 시간이 다 되면 강제로 넘어갈 상태 — 반드시 TRANSITIONS 안의 간선이어야 한다 */
  readonly next: KioskState;
}

/**
 * ── 무인 운영 타임아웃 표 (이 파일이 유일한 출처) ─────────────────
 *
 * ATTRACT 만 무한 대기다(관객을 기다리는 것이 일). 나머지는 전부 시한부.
 * next 는 TRANSITIONS 의 간선만 쓴다 — test/state.test.ts 가 이를 강제한다.
 */
export const STATE_TIMEOUTS: Record<KioskState, StateTimeout | null> = {
  ATTRACT: null, // 유휴 화면 — 관객이 올 때까지 기다린다
  CONSENT: { ms: 20_000, next: 'ATTRACT' }, // §4 명시: 거절/20초 무응답
  CREATE: { ms: 12_000, next: 'ERROR_RECOVER' }, // 카메라 권한 + 씨앗 추출(예산 1.5s)
  TRANSFORM: { ms: 8_000, next: 'MATERIALIZE' }, // L1 0.8s + L2 승격 포기선 8s(§8)
  MATERIALIZE: { ms: 5_000, next: 'OWN' }, // 가방 적용 — 실패해도 소유 단계로 민다
  OWN: { ms: 15_000, next: 'RESET' }, // 이름 입력 무응답 → 이탈로 간주
  RESET: { ms: 2_000, next: 'ATTRACT' }, // 파기 후 인사말 한 박자
  ERROR_RECOVER: { ms: 5_000, next: 'ATTRACT' }, // 안내 문구를 읽을 시간
};

/**
 * OWN 안에서 이름 제출 이후 다시 감는 타이머 — QR 을 폰으로 찍을 시간.
 * 녹화(CLIP_SECONDS)·업로드 자체는 타이머를 멈춘 채 진행한다(중간에 끊으면 결과가 사라진다).
 */
export const OWN_RESULT_VIEW_MS = 12_000;

/** §8 성능 예산: 세션 전체 ≤ 90초. 아래 SESSION_BUDGET_ITEMS 합이 이 값을 넘으면 테스트 실패. */
export const SESSION_BUDGET_MS = 90_000;

/** 녹화 길이(output/recorder.ts CLIP_SECONDS)를 예산 항목으로 명시 — 잊고 세면 예산이 거짓말이 된다. */
export const RECORD_CLIP_MS = 8_000;

/** 최악의 경우 한 세션이 쓰는 시간 항목들 (ATTRACT 는 세션 밖이라 제외). */
export const SESSION_BUDGET_ITEMS: readonly { label: string; ms: number }[] = [
  { label: 'CONSENT', ms: STATE_TIMEOUTS.CONSENT!.ms },
  { label: 'CREATE', ms: STATE_TIMEOUTS.CREATE!.ms },
  { label: 'TRANSFORM', ms: STATE_TIMEOUTS.TRANSFORM!.ms },
  { label: 'MATERIALIZE', ms: STATE_TIMEOUTS.MATERIALIZE!.ms },
  { label: 'OWN(이름 입력)', ms: STATE_TIMEOUTS.OWN!.ms },
  { label: 'OWN(녹화)', ms: RECORD_CLIP_MS },
  { label: 'OWN(QR 감상)', ms: OWN_RESULT_VIEW_MS },
  { label: 'RESET', ms: STATE_TIMEOUTS.RESET!.ms },
];

export const sessionBudgetTotalMs = (): number =>
  SESSION_BUDGET_ITEMS.reduce((sum, item) => sum + item.ms, 0);

export type TransitionReason = 'init' | 'event' | 'timeout' | 'operator';
export type StateListener = (next: KioskState, prev: KioskState, reason: TransitionReason) => void;

export class StateMachine {
  private current: KioskState = 'ATTRACT';
  private listeners = new Set<StateListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deadline = 0;
  private timeoutsEnabled = true;

  get state(): KioskState {
    return this.current;
  }

  /** 디버그 버튼 모드(?debug=1)에서는 개발자가 화면을 붙잡고 있으므로 타이머를 끈다. */
  setTimeoutsEnabled(enabled: boolean): void {
    this.timeoutsEnabled = enabled;
    if (enabled) this.armTimeout();
    else this.clearTimer();
  }

  can(next: KioskState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }

  /** @returns 전이 성공 여부. 허용되지 않은 전이는 경고만 남기고 무시한다. */
  to(next: KioskState, reason: TransitionReason = 'event'): boolean {
    if (!this.can(next)) {
      console.warn(`[state] 허용되지 않은 전이: ${this.current} → ${next}`);
      return false;
    }
    this.commit(next, reason);
    return true;
  }

  /**
   * 전이 표를 건너뛰는 **운영자 전용** 탈출구 (ARCHITECTURE §9 '전체 장애' 행의 손잡이).
   *
   * 강제 RESET 은 어느 상태에서든 걸려야 하는데 TRANSITIONS 에는 OWN→RESET 간선밖에 없다.
   * 그렇다고 표에 간선을 더하면 §4 다이어그램과 어긋난다 — 그래서 표는 그대로 두고
   * 이 함수만 예외로 둔다. to() 와 같은 경로(commit)를 타므로 타이머 재장전과 리스너 통지,
   * 즉 RESET 진입의 에포크 증가·세션 파기가 **똑같이** 일어난다.
   *
   * 여정 배선(kiosk.ts)의 자동 진행은 절대 이 함수를 쓰지 않는다. TRANSITIONS 가 유일한 출처다.
   */
  forceTo(next: KioskState, reason: TransitionReason = 'operator'): void {
    if (!this.can(next)) {
      console.info(`[state] 운영자 강제 전이: ${this.current} → ${next}`);
    }
    this.commit(next, reason);
  }

  private commit(next: KioskState, reason: TransitionReason): void {
    const prev = this.current;
    this.current = next;
    this.armTimeout();
    this.listeners.forEach((fn) => fn(next, prev, reason));
  }

  onChange(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 현재 상태 타임아웃까지 남은 ms (타이머가 없으면 null) — 동의 화면 카운트다운용. */
  get remainingMs(): number | null {
    if (this.timer === null) return null;
    return Math.max(0, this.deadline - Date.now());
  }

  /** 녹화·업로드처럼 "끊으면 결과가 사라지는" 구간에서 타이머를 멈춘다. */
  pauseTimeout(): void {
    this.clearTimer();
  }

  /** 기본 표 대신 다른 시간으로 다시 감는다 (OWN 의 QR 감상 시간 등). */
  rearm(ms: number, next: KioskState): void {
    this.clearTimer();
    if (!this.timeoutsEnabled) return;
    this.startTimer(ms, next);
  }

  /** 페이지 종료/테스트 정리용. */
  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }

  private armTimeout(): void {
    this.clearTimer();
    if (!this.timeoutsEnabled) return;
    const timeout = STATE_TIMEOUTS[this.current];
    if (!timeout) return;
    this.startTimer(timeout.ms, timeout.next);
  }

  private startTimer(ms: number, next: KioskState): void {
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      console.info(`[state] 타임아웃 ${ms}ms — ${this.current} → ${next}`);
      this.to(next, 'timeout');
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = 0;
  }
}
