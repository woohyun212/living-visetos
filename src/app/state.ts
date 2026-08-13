/**
 * E · StateMachine 골격 (ARCHITECTURE §4 상태 다이어그램을 표로 옮긴 것)
 *
 * 🚧 W1 스텁: 전이 표와 최소 API만 있다. 아래는 E 담당의 과제다.
 *   - 상태별 타임아웃 (무인 운영 대비)
 *   - EventBus / SessionStore 분리
 *   - RESET 에서 세션 메모리 전체 파기 (원칙 4)
 * main.ts 의 버튼 플로우는 아직 이 머신을 통과하지 않는다 — 연결도 E 담당 과제.
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

export type StateListener = (next: KioskState, prev: KioskState) => void;

export class StateMachine {
  private current: KioskState = 'ATTRACT';
  private listeners = new Set<StateListener>();

  get state(): KioskState {
    return this.current;
  }

  can(next: KioskState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }

  /** @returns 전이 성공 여부. 허용되지 않은 전이는 경고만 남기고 무시한다. */
  to(next: KioskState): boolean {
    if (!this.can(next)) {
      console.warn(`[state] 허용되지 않은 전이: ${this.current} → ${next}`);
      return false;
    }
    const prev = this.current;
    this.current = next;
    this.listeners.forEach((fn) => fn(next, prev));
    return true;
  }

  onChange(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
