/**
 * E · KioskFlow — ATTRACT→OWN 여정의 배선.
 *
 * StateMachine 은 "언제"만 알고, main.ts 는 "어떻게"만 안다. 이 파일이 둘을 잇는다.
 * 모든 상태 전이는 state.ts 의 TRANSITIONS 를 통과한다 — 허용 밖 전이는 코드 버그이고
 * StateMachine.to() 가 console.warn 으로 남긴다.
 *
 * 세션 에포크(epoch): record()·deliver() 는 수 초가 걸린다. 그 사이 타임아웃이 걸려
 * RESET→ATTRACT 로 넘어갔다면, 늦게 도착한 응답이 **다음 관객 화면에 이전 관객의 QR** 을
 * 그려선 안 된다. await 앞에서 에포크를 찍고, 뒤에서 달라졌으면 조용히 버린다.
 */
import type { KioskState } from '../contracts.ts';
import type { KioskView } from './kiosk-view.ts';
import { OWN_RESULT_VIEW_MS, STATE_TIMEOUTS, type StateMachine } from './state.ts';

/** 이름을 짓지 않고 떠난 관객의 기본값 (기존 하드코딩 값을 폴백으로 강등). */
export const DEFAULT_PATTERN_NAME = '나의 비세토스';

/** main.ts 가 제공하는 "어떻게" — 이 인터페이스 밖의 모듈 지식은 여기 들어오지 않는다. */
export interface KioskSteps {
  /** ATTRACT 진입 시 세그멘테이션 모델 예열 (다음 관객의 CREATE 예산을 지킨다). */
  warmUp(): void;
  startCamera(): Promise<void>;
  extractSeed(): Promise<void>;
  makeTile(): Promise<void>;
  setOverlay(on: boolean): void;
  toggleOverlay(): void;
  applyBag(): void;
  /** 녹화 + 전송 + 결과 카드(QR) 표시. 내부에서 실패를 삼키고 화면에 안내한다. */
  deliver(patternName: string): Promise<void>;
  /** RESET — 세션 상태·마스크·타일·오버레이·결과 카드를 전부 버린다. */
  destroySession(): void;
  status(message: string): void;
  readonly clipSeconds: number;
}

/** 디버그 버튼 1개 = 여정의 한 칸. 기존 버튼 의미를 그대로 유지한다. */
export type KioskStep = 'camera' | 'seed' | 'tile' | 'overlay' | 'bag' | 'deliver' | 'all';

/** 정상 여정의 외길 (ERROR_RECOVER 는 곁가지라 제외). */
const MAIN_PATH: readonly KioskState[] = [
  'ATTRACT',
  'CONSENT',
  'CREATE',
  'TRANSFORM',
  'MATERIALIZE',
  'OWN',
  'RESET',
];

const BADGE_TICK_MS = 500;

export interface KioskFlowOptions {
  machine: StateMachine;
  view: KioskView;
  steps: KioskSteps;
  /** ?debug=1 — 자동 진행과 타임아웃을 끄고 버튼이 여정을 직접 민다. */
  debug: boolean;
}

export class KioskFlow {
  private readonly machine: StateMachine;
  private readonly view: KioskView;
  private readonly steps: KioskSteps;
  private readonly debug: boolean;

  private epoch = 0;
  private running: string | null = null;
  private lastError = '카메라를 찾지 못했습니다.';
  private readonly badgeTimer: ReturnType<typeof setInterval>;

  constructor({ machine, view, steps, debug }: KioskFlowOptions) {
    this.machine = machine;
    this.view = view;
    this.steps = steps;
    this.debug = debug;

    machine.setTimeoutsEnabled(!debug);
    machine.onChange((next, prev, reason) => this.onEnter(next, prev, reason));

    view.onAttractTouch(() => machine.to('CONSENT'));
    view.onConsent((agreed) => machine.to(agreed ? 'CREATE' : 'ATTRACT'));
    view.onNameSubmit((name) => void this.runOwn(name));

    this.badgeTimer = setInterval(
      () => view.renderBadge(machine.state, machine.remainingMs),
      BADGE_TICK_MS,
    );

    this.onEnter('ATTRACT', 'ATTRACT', 'init');
  }

  get state(): KioskState {
    return this.machine.state;
  }

  /** 버튼 패널의 진입점 — 키오스크·디버그 양쪽 모두 이 함수를 통과한다. */
  async requestStep(step: KioskStep): Promise<void> {
    if (step === 'overlay') {
      this.steps.toggleOverlay();
      return;
    }
    if (step === 'all') {
      await this.runAll();
      return;
    }

    const target = STEP_TARGET[step];
    if (!this.advanceTo(target)) {
      this.steps.status(`지금(${this.machine.state}) 은 이 단계로 갈 수 없습니다.`);
      return;
    }
    // 키오스크 모드에서는 상태 진입(onEnter)이 알아서 모듈을 부른다. 디버그 모드만 직접 민다.
    if (!this.debug) return;

    switch (step) {
      case 'camera':
        await this.guard('camera', () => this.steps.startCamera());
        break;
      case 'seed':
        await this.guard('seed', async () => {
          await this.steps.extractSeed();
          this.machine.to('TRANSFORM');
        });
        break;
      case 'tile':
        await this.guard('tile', () => this.steps.makeTile());
        break;
      case 'bag':
        this.steps.applyBag();
        break;
      case 'deliver':
        this.view.showNaming(DEFAULT_PATTERN_NAME);
        break;
    }
  }

  dispose(): void {
    clearInterval(this.badgeTimer);
  }

  // ── 상태 진입 ──────────────────────────────────
  private onEnter(next: KioskState, prev: KioskState, reason: string): void {
    console.info(`[state] ${prev} → ${next} (${reason})`);
    this.view.renderBadge(next, this.machine.remainingMs);

    switch (next) {
      case 'ATTRACT':
        this.view.showAttract();
        this.steps.status('터치하여 시작하세요.');
        this.steps.warmUp();
        break;

      case 'CONSENT':
        this.steps.status('카메라 사용 동의를 기다립니다 — 20초 무응답이면 처음 화면으로.');
        this.view.showConsent(STATE_TIMEOUTS.CONSENT!.ms, () => this.machine.remainingMs);
        break;

      case 'CREATE':
        this.steps.status('카메라를 켜고 색과 움직임을 읽습니다.');
        this.view.showProgress('CREATE', '당신의 색을 읽는 중', '잠시 자연스럽게 움직여주세요.');
        if (!this.debug) void this.runCreate();
        break;

      case 'TRANSFORM':
        this.steps.status('씨앗에서 패턴이 태어납니다.');
        this.view.showProgress('TRANSFORM', '패턴을 짓는 중', '당신이 방금 태어난 패턴으로 변합니다.');
        if (!this.debug) void this.runTransform();
        break;

      case 'MATERIALIZE':
        this.steps.status('패턴을 물건에 입힙니다.');
        this.view.showProgress('MATERIALIZE', '가방에 입히는 중', '방금 태어난 나의 빽.');
        if (!this.debug) void this.runMaterialize();
        break;

      case 'OWN':
        this.steps.status('패턴의 이름을 지어주세요.');
        this.view.showNaming(DEFAULT_PATTERN_NAME);
        break;

      case 'RESET':
        this.epoch += 1; // 늦게 도착할 record/deliver 응답을 여기서 무효화한다
        this.steps.destroySession();
        this.steps.status('세션을 파기했습니다.');
        this.view.showFarewell();
        break;

      case 'ERROR_RECOVER':
        this.epoch += 1;
        this.steps.destroySession();
        this.steps.status(this.lastError);
        this.view.showError(this.lastError);
        break;
    }
  }

  // ── 자동 진행 (키오스크 모드) ──────────────────
  private async runCreate(): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.guard('create', async () => {
        await this.steps.startCamera();
        if (this.stale(epoch, 'CREATE')) return;
        await this.steps.extractSeed();
      });
    } catch (error) {
      if (this.stale(epoch, 'CREATE')) return;
      this.lastError = error instanceof Error ? error.message : '카메라·씨앗 추출에 실패했습니다.';
      this.machine.to('ERROR_RECOVER');
      return;
    }
    if (this.stale(epoch, 'CREATE')) return;
    this.machine.to('TRANSFORM');
  }

  private async runTransform(): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.guard('transform', () => this.steps.makeTile());
    } catch (error) {
      if (this.stale(epoch, 'TRANSFORM')) return;
      this.lastError = error instanceof Error ? error.message : '패턴 생성에 실패했습니다.';
      // TRANSFORM → ERROR_RECOVER 간선은 없다(§4). 다음 관객을 위해 정상 경로로 빠져나간다.
      this.machine.to('MATERIALIZE');
      return;
    }
    if (this.stale(epoch, 'TRANSFORM')) return;
    this.steps.setOverlay(true);
    this.machine.to('MATERIALIZE');
  }

  private runMaterialize(): void {
    const epoch = this.epoch;
    this.steps.applyBag();
    if (this.stale(epoch, 'MATERIALIZE')) return;
    this.machine.to('OWN');
  }

  /** OWN — 이름 확정 → 녹화/전송 → QR 감상 타이머. 이름 입력 타이머는 여기서 끝난다. */
  private async runOwn(patternName: string): Promise<void> {
    if (this.machine.state !== 'OWN' || this.running !== null) return;
    const epoch = this.epoch;

    this.machine.pauseTimeout(); // 녹화·업로드 중간에 끊으면 결과가 사라진다
    this.view.showDelivering(patternName, this.steps.clipSeconds);
    this.steps.status(`「${patternName}」 을(를) ${this.steps.clipSeconds}초 동안 담고 있습니다.`);

    try {
      await this.guard('own', () => this.steps.deliver(patternName));
    } catch (error) {
      console.warn('[state] 결과 전달 실패', error);
    }

    if (this.stale(epoch, 'OWN')) return;
    this.view.showResult();
    this.machine.rearm(OWN_RESULT_VIEW_MS, 'RESET');
  }

  private async runAll(): Promise<void> {
    if (!this.debug) {
      this.advanceTo('CREATE'); // 키오스크 모드: 상태 진입이 나머지를 자동으로 굴린다
      return;
    }
    await this.requestStep('camera');
    await this.requestStep('seed');
    await this.requestStep('tile');
    this.steps.setOverlay(true);
    await this.requestStep('bag');
    await this.requestStep('deliver');
  }

  // ── 도우미 ────────────────────────────────────
  /** 정상 여정의 외길을 따라 target 까지 한 칸씩 — 모든 칸이 TRANSITIONS 를 통과한다. */
  private advanceTo(target: KioskState): boolean {
    if (this.machine.state === target) return true;
    if (this.machine.state === 'ERROR_RECOVER' || this.machine.state === 'RESET') {
      this.machine.to('ATTRACT');
    }

    // 뒤로 가는 요청은 "다음 관객" 이라는 뜻이다 — RESET(세션 파기)을 반드시 거쳐 처음으로 돌아간다.
    const here = MAIN_PATH.indexOf(this.machine.state);
    const there = MAIN_PATH.indexOf(target);
    if (here >= 0 && there >= 0 && there <= here) {
      this.walk('RESET');
      this.machine.to('ATTRACT');
    }
    return this.walk(target);
  }

  private walk(target: KioskState): boolean {
    for (let hop = 0; hop < MAIN_PATH.length; hop += 1) {
      if (this.machine.state === target) return true;
      const here = MAIN_PATH.indexOf(this.machine.state);
      const there = MAIN_PATH.indexOf(target);
      if (here < 0 || there <= here) return false;
      if (!this.machine.to(MAIN_PATH[here + 1]!)) return false;
    }
    return this.machine.state === target;
  }

  /** await 전후로 세션이 바뀌었는지 — 바뀌었으면 늦게 온 결과를 화면에 쓰지 않는다. */
  private stale(epoch: number, expected: KioskState): boolean {
    const changed = this.epoch !== epoch || this.machine.state !== expected;
    if (changed) console.info(`[state] 만료된 작업 폐기 (epoch ${epoch}, expected ${expected})`);
    return changed;
  }

  /** 같은 단계가 겹쳐 도는 것을 막는다 (버튼 연타·자동 진행 중복). */
  private async guard(key: string, run: () => Promise<void> | void): Promise<void> {
    if (this.running !== null) return;
    this.running = key;
    try {
      await run();
    } finally {
      this.running = null;
    }
  }
}

const STEP_TARGET: Record<Exclude<KioskStep, 'overlay' | 'all'>, KioskState> = {
  camera: 'CREATE',
  seed: 'CREATE',
  tile: 'TRANSFORM',
  bag: 'MATERIALIZE',
  deliver: 'OWN',
};
