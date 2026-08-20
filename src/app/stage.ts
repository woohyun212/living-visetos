/**
 * E · StageView — 관객이 보는 무대 화면 (세로 비디오월 1080×1920).
 *
 * KioskFlow(ATTRACT→OWN)의 각 상태가 무대의 '장면'이 된다. 여정 배선은 그대로 두고
 * 연출층만 얹은 것이므로, 이 파일은 KioskScreen 인터페이스만 구현한다.
 *
 * 무대의 원칙 세 가지:
 *   1) 좌표는 항상 1080×1920 — .stageFrame 을 scale() 로만 맞춘다(cover, 레터박스 없음).
 *   2) 장면 전환은 opacity/transform 뿐 — display:none 은 쓰지 않는다.
 *      #overlayCanvas 가 레이아웃에서 빠지면 main.ts 의 canDeliver() 가 막혀
 *      OWN 의 녹화가 조용히 실패한다(kiosk-view.ts 의 같은 경고와 같은 이유).
 *   3) ATTRACT 에 로고·브랜드 문자를 쓰지 않는다(가드레일). 패턴이 주인공이다.
 *
 * ?debug=1 계기판은 이 파일을 전혀 통과하지 않는다 — main.ts 가 KioskView 를 대신 쓴다.
 */
import type { FeatureSeed, KioskState } from '../contracts.ts';
import { generateTile } from '../pattern/l1.ts';
import type { KioskScreen } from './kiosk-view.ts';
import './stage.css';

/** 무대 설계 해상도. 창 크기가 달라도 이 비율은 유지된다. */
const STAGE_WIDTH = 1080;
const STAGE_HEIGHT = 1920;

/**
 * ATTRACT 유휴 루프의 고정 시드 순환.
 * sessionId 까지 포함해 해싱되므로(createSeedRef) 값은 반드시 리터럴이어야
 * 매번 같은 패턴이 같은 순서로 돌아온다 — 전시장에서 재현 가능한 배경.
 */
const IDLE_SEEDS: readonly FeatureSeed[] = [
  {
    dominantColors: ['#A9652C', '#C9A227', '#F7F3EC'],
    motionEnergy: 0.22,
    rhythm: 0.38,
    sessionId: 'stage-idle-0',
  },
  {
    dominantColors: ['#C9A227', '#F7F3EC', '#A9652C'],
    motionEnergy: 0.55,
    rhythm: 0.62,
    sessionId: 'stage-idle-1',
  },
  {
    dominantColors: ['#F7F3EC', '#A9652C', '#181512'],
    motionEnergy: 0.41,
    rhythm: 0.84,
    sessionId: 'stage-idle-2',
  },
  {
    dominantColors: ['#181512', '#C9A227', '#A9652C'],
    motionEnergy: 0.73,
    rhythm: 0.19,
    sessionId: 'stage-idle-3',
  },
];

/** 무대 위에서 타일 한 장이 차지하는 크기(px). 멀리서도 모티프가 읽히는 선. */
const IDLE_TILE_PX = 640;
/** 한 패턴이 머무는 시간 — 관객이 "변한다" 를 알아챌 만큼만 천천히. */
const IDLE_CYCLE_MS = 11_000;
const IDLE_FADE_MS = 2_200;
/** 유휴 배경은 30fps 면 충분하다 — 남는 예산은 세그멘테이션 예열에 준다. */
const IDLE_FRAME_MS = 1000 / 30;
/** 패턴이 흐르는 속도(px/ms). 눈에 겨우 띄는 정도. */
const IDLE_DRIFT = 0.007;

const COUNTDOWN_TICK_MS = 500;

/**
 * 전체 장애 폴백 영상(§9 마지막 행). 리포에 커밋하지 않는다(.gitignore 의 *.mp4) —
 * 운영자가 데모데이 전에 이 경로에 직접 놓는다. 준비 방법은 docs/OPERATIONS.md.
 * 파일이 없으면 아래 플레이스홀더가 대신 뜬다.
 */
const FALLBACK_VIDEO_SRC = '/assets/fallback.mp4';

type Handler<T> = (value: T) => void;
const noop = (): void => {};

/** 상태 → 장면 레이어. CREATE/TRANSFORM/MATERIALIZE 는 같은 '만드는 중' 장면을 공유한다. */
const SCENE_OF: Record<KioskState, 'attract' | 'consent' | 'progress' | 'own' | 'notice'> = {
  ATTRACT: 'attract',
  CONSENT: 'consent',
  CREATE: 'progress',
  TRANSFORM: 'progress',
  MATERIALIZE: 'progress',
  OWN: 'own',
  RESET: 'notice',
  ERROR_RECOVER: 'notice',
};

export interface StageViewOptions {
  /** 무대 안으로 옮겨올 카메라 영상 (거울 정합을 위해 오버레이와 같은 박스를 쓴다). */
  video: HTMLVideoElement;
  /** ⚠️ 절대 display:none 되지 않아야 하는 캔버스 — 녹화 입력이다. */
  overlayCanvas: HTMLCanvasElement;
  /** 3D 가방 프리뷰 컨테이너 (MATERIALIZE 하단 1/3). */
  bagWrap: HTMLElement;
  /** 기존 결과 카드(D · F-05) — 마크업 재사용, 무대 톤으로만 다시 칠한다. */
  resultCard: HTMLElement;
}

export class StageView implements KioskScreen {
  private readonly root: HTMLDivElement;
  private readonly frame: HTMLDivElement;
  private readonly camera: HTMLDivElement;
  private readonly idleCanvas: HTMLCanvasElement;
  private readonly idleCtx: CanvasRenderingContext2D | null;
  private readonly scenes: Record<string, HTMLDivElement>;
  private readonly progressHeadline: HTMLParagraphElement;
  private readonly progressNote: HTMLParagraphElement;
  private readonly seedStrip: HTMLDivElement;
  private readonly seedChips: HTMLSpanElement[];
  private readonly consentCountdown: HTMLParagraphElement;
  private readonly ownCard: HTMLDivElement;
  private readonly noticeEyebrow: HTMLParagraphElement;
  private readonly noticeHeadline: HTMLParagraphElement;
  private readonly noticeNote: HTMLParagraphElement;
  private readonly noticeOpsHint: HTMLParagraphElement;
  private readonly demoBadge: HTMLDivElement;
  private readonly fallback: HTMLDivElement;
  private readonly fallbackVideo: HTMLVideoElement;
  private readonly fallbackPlaceholder: HTMLDivElement;

  private attractHandler: Handler<void> = noop;
  private consentHandler: Handler<boolean> = noop;
  private nameHandler: Handler<string> = noop;

  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onResize = (): void => this.fit();

  // ── ATTRACT 유휴 루프 상태 ──
  private idleRaf: number | null = null;
  private idleIndex = 0;
  private idleCurrent: ImageBitmap | null = null;
  private idleNext: ImageBitmap | null = null;
  private idleCurrentPattern: CanvasPattern | null = null;
  private idleNextPattern: CanvasPattern | null = null;
  private idleGenerating = false;
  private idleCycleStart = 0;
  private idleFadeStart = 0;
  private idleLastFrame = 0;
  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(options: StageViewOptions) {
    document.body.classList.add('is-stage');

    this.root = el('div', 'stageRoot');
    this.root.id = 'stageRoot';
    this.root.dataset['scene'] = 'ATTRACT';
    this.root.setAttribute('aria-live', 'polite');

    this.frame = el('div', 'stageFrame');
    this.root.append(this.frame);

    // 1) 유휴 패턴 배경
    const idle = el('div', 'stageIdle');
    this.idleCanvas = document.createElement('canvas');
    this.idleCanvas.className = 'stageIdleCanvas';
    this.idleCanvas.width = STAGE_WIDTH;
    this.idleCanvas.height = STAGE_HEIGHT;
    this.idleCtx = this.idleCanvas.getContext('2d');
    idle.append(this.idleCanvas);

    // 2) 카메라 미러 스테이지 — 기존 노드를 그대로 옮겨온다(참조·WebGL 컨텍스트 유지).
    this.camera = el('div', 'stageCamera');
    this.camera.append(options.video, options.overlayCanvas);

    const veil = el('div', 'stageVeil');

    // 3) 장면 레이어
    const attract = this.buildAttract();
    const consent = this.buildConsent();
    const progress = this.buildProgress();
    const own = this.buildOwn(options.resultCard);
    const notice = this.buildNotice();

    // 4) 가방 슬롯 — 무대 하단 1/3
    const bagSlot = el('div', 'stageBagSlot');
    bagSlot.append(options.bagWrap);

    // 5) 운영 레이어 — 관객에게는 데모 표기만, 폴백 화면은 운영자가 부를 때만.
    this.demoBadge = text('div', 'stageDemoBadge', '데모 모드 · 목 카메라');
    this.demoBadge.hidden = true;
    this.fallback = this.buildFallback();
    this.fallbackVideo = this.fallback.querySelector<HTMLVideoElement>('.stageFallbackVideo')!;
    this.fallbackPlaceholder =
      this.fallback.querySelector<HTMLDivElement>('.stageFallbackPlaceholder')!;

    this.frame.append(
      idle,
      this.camera,
      veil,
      bagSlot,
      attract,
      consent,
      progress,
      own,
      notice,
      this.demoBadge,
      this.fallback,
    );
    document.body.append(this.root);

    this.scenes = { attract, consent, progress, own, notice };
    this.progressHeadline = progress.querySelector<HTMLParagraphElement>('.stageHeadline')!;
    this.progressNote = progress.querySelector<HTMLParagraphElement>('.stageSub')!;
    this.seedStrip = progress.querySelector<HTMLDivElement>('.stageSeed')!;
    this.seedChips = Array.from(this.seedStrip.children) as HTMLSpanElement[];
    this.consentCountdown = consent.querySelector<HTMLParagraphElement>('.stageCountdown')!;
    this.ownCard = own.querySelector<HTMLDivElement>('.stageCard')!;
    this.noticeEyebrow = notice.querySelector<HTMLParagraphElement>('.stageEyebrow')!;
    this.noticeHeadline = notice.querySelector<HTMLParagraphElement>('.stageHeadline')!;
    this.noticeNote = notice.querySelector<HTMLParagraphElement>('.stageSub')!;
    this.noticeOpsHint = notice.querySelector<HTMLParagraphElement>('.stageOpsHint')!;

    this.root.onclick = () => {
      if (this.root.dataset['scene'] === 'ATTRACT') this.attractHandler();
    };

    addEventListener('resize', this.onResize);
    this.fit();
    this.setScene('ATTRACT');
  }

  // ── KioskScreen ────────────────────────────────
  onAttractTouch(fn: Handler<void>): void {
    this.attractHandler = fn;
  }

  onConsent(fn: Handler<boolean>): void {
    this.consentHandler = fn;
  }

  onNameSubmit(fn: Handler<string>): void {
    this.nameHandler = fn;
  }

  /** 무대에는 상태 뱃지를 띄우지 않는다 — 계기판은 ?debug=1 의 몫이다. */
  renderBadge(_state: KioskState, _remainingMs: number | null): void {}

  showAttract(): void {
    this.setScene('ATTRACT');
  }

  showConsent(totalMs: number, remaining: () => number | null): void {
    this.setScene('CONSENT');
    const label = (ms: number): string => `${Math.ceil(ms / 1000)}초 후 처음 화면으로 돌아갑니다`;
    this.consentCountdown.textContent = label(totalMs);
    this.stopCountdown();
    this.countdownTimer = setInterval(() => {
      const ms = remaining();
      if (ms === null) return;
      this.consentCountdown.textContent = label(ms);
    }, COUNTDOWN_TICK_MS);
  }

  showProgress(state: KioskState, headline: string, note: string): void {
    this.setScene(state);
    this.progressHeadline.textContent = headline;
    this.progressNote.textContent = note;
  }

  showNaming(defaultName: string): void {
    this.setScene('OWN');
    this.ownCard.hidden = false;
    this.ownCard.replaceChildren(
      text('p', 'stageEyebrow', '이름 짓기'),
      text('p', 'stageHeadline', '이 패턴의 이름을 지어주세요'),
      text('p', 'stageSub', '입력한 이름이 결과 인증서에 새겨집니다.'),
      this.buildNameForm(defaultName),
    );
    (this.ownCard.querySelector('.stageInput') as HTMLInputElement | null)?.focus();
  }

  showDelivering(patternName: string, seconds: number): void {
    this.setScene('OWN');
    this.ownCard.hidden = false;
    this.ownCard.replaceChildren(
      text('p', 'stageEyebrow', '담는 중'),
      text('p', 'stageHeadline', `「${patternName}」`),
      text('p', 'stageSub', `${seconds}초 동안 지금 이 장면을 담고 있습니다.`),
      text('p', 'stageNote', '끝나면 QR 코드가 나타납니다.'),
    );
  }

  /** 결과 카드(#resultCard)는 main.ts 가 켠다 — 무대는 이름 카드만 비켜준다. */
  showResult(): void {
    this.setScene('OWN');
    this.ownCard.hidden = true;
    this.ownCard.replaceChildren();
  }

  showFarewell(): void {
    this.setScene('RESET');
    this.noticeEyebrow.textContent = '세션 종료';
    this.noticeHeadline.textContent = '고맙습니다';
    this.noticeNote.textContent = '나만의 패턴과 함께한 시간이었습니다.';
    this.noticeOpsHint.textContent = '';
  }

  /**
   * ERROR_RECOVER — 카메라·씨앗 추출이 실패한 유일한 화면(§4). 그래서 여기에만
   * 운영자용 탈출구를 적어 둔다: 목 카메라 데모 모드로 여정을 이어가는 단축키(§9 '카메라 실패' 행).
   * 나머지 단축키는 화면 어디에도 적지 않는다 — 무대는 관객의 것이다.
   */
  showError(message: string): void {
    this.setScene('ERROR_RECOVER');
    this.noticeEyebrow.textContent = '다시 시도';
    this.noticeHeadline.textContent = '잠시 문제가 있었습니다';
    this.noticeNote.textContent = message;
    this.noticeOpsHint.textContent = '운영자 · Shift+D — 데모 모드로 계속';
  }

  dispose(): void {
    this.stopCountdown();
    this.hideFallback();
    this.stopIdle();
    this.idleCurrent?.close();
    this.idleNext?.close();
    this.idleCurrent = this.idleNext = null;
    removeEventListener('resize', this.onResize);
    document.body.classList.remove('is-stage');
    this.root.remove();
  }

  // ── 무대 전용 연출 훅 (main.ts 가 부른다) ───────
  /** 씨앗 추출 순간 — 뽑힌 색 3개가 화면에 떠오른다 (요구사항 3). */
  revealSeedColors(colors: readonly string[]): void {
    this.seedChips.forEach((chip, i) => {
      chip.style.background = colors[i] ?? 'transparent';
    });
    this.seedStrip.classList.add('is-on');
  }

  /** 실루엣 오버레이 페이드인/아웃. 캔버스는 계속 레이아웃에 남는다(녹화 입력). */
  setOverlayVisible(on: boolean): void {
    this.camera.dataset['overlay'] = on ? 'on' : 'off';
  }

  /** 데모 모드(목 카메라) 표기 — 관객을 속이지 않는다. 작게, 구석에. */
  setDemoMode(on: boolean): void {
    this.demoBadge.hidden = !on;
  }

  /**
   * 전체 장애 폴백 화면(§9 마지막 행) — 무대 전체를 사전 녹화 영상으로 덮는다.
   * 영상이 없으면 '폴백 영상 준비 필요' 플레이스홀더가 그대로 남는다(운영자만 보는 화면이 아니므로
   * 관객에게도 읽히는 문구로 쓴다).
   */
  showFallback(): void {
    this.fallback.hidden = false;
    this.fallbackVideo.classList.remove('is-on');
    this.fallbackPlaceholder.hidden = false;
    this.fallbackVideo.src = FALLBACK_VIDEO_SRC;
    void this.fallbackVideo.play().catch(() => {
      // 파일이 없거나 자동재생이 막혔다 — 플레이스홀더가 화면을 지킨다.
    });
  }

  hideFallback(): void {
    this.fallback.hidden = true;
    this.fallbackVideo.pause();
    this.fallbackVideo.removeAttribute('src');
    this.fallbackVideo.load(); // 디코더·네트워크 요청을 놓는다
  }

  // ── 내부: 레이아웃 ─────────────────────────────
  /** 창이 1080×1920 이 아니어도 비율을 지킨다 — 모자란 쪽을 잘라내는 cover. */
  private fit(): void {
    const scale = Math.max(innerWidth / STAGE_WIDTH, innerHeight / STAGE_HEIGHT);
    this.frame.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  private setScene(state: KioskState): void {
    if (this.root.dataset['scene'] !== state) this.root.dataset['scene'] = state;

    const active = SCENE_OF[state];
    for (const [name, node] of Object.entries(this.scenes)) {
      node.classList.toggle('is-on', name === active);
    }
    if (active !== 'consent') this.stopCountdown();

    /*
     * OWN 을 떠나면 이름 카드를 비운다. 두 가지 이유가 있고 둘 다 실제로 물린다.
     *   1) 앞 관객이 친 이름이 다음 장면 뒤에 DOM 으로 남는다 (원칙 4).
     *   2) 사라진 #patternNameInput 이 계속 포커스를 쥐고 있으면 app/ops.ts 의 입력 가드가
     *      Shift+D·Shift+F 를 영영 막는다 — 첫 관객 이후로 운영자 단축키가 먹통이 된다.
     */
    if (active !== 'own') {
      this.ownCard.hidden = true;
      this.ownCard.replaceChildren();
    }

    // 유휴 루프는 ATTRACT/CONSENT/RESET/ERROR_RECOVER 배경에서만 돈다.
    // CREATE 의 씨앗 추출 예산(1.5s)을 배경 렌더가 갉아먹지 않게 나머지에서는 멈춘다.
    if (active === 'attract' || active === 'consent' || active === 'notice') this.startIdle();
    else this.stopIdle();

    if (state === 'ATTRACT') {
      this.seedStrip.classList.remove('is-on');
      this.setOverlayVisible(false);
    }
  }

  // ── 내부: ATTRACT 유휴 패턴 루프 ───────────────
  private startIdle(): void {
    if (this.idleRaf !== null || !this.idleCtx) return;
    if (!this.idleCurrent && !this.idleGenerating) void this.nextIdleTile();
    this.idleRaf = requestAnimationFrame((now) => this.idleTick(now));
  }

  private stopIdle(): void {
    if (this.idleRaf !== null) cancelAnimationFrame(this.idleRaf);
    this.idleRaf = null;
  }

  private idleTick(now: number): void {
    this.idleRaf = requestAnimationFrame((next) => this.idleTick(next));
    if (now - this.idleLastFrame < IDLE_FRAME_MS) return;
    this.idleLastFrame = now;

    if (this.idleCycleStart === 0) this.idleCycleStart = now;
    if (now - this.idleCycleStart >= IDLE_CYCLE_MS && !this.idleGenerating && !this.idleNext) {
      void this.nextIdleTile();
    }
    this.paintIdle(now);
  }

  /** 다음 고정 시드로 타일 한 장을 미리 굽는다. 실패하면 지금 패턴을 그대로 둔다. */
  private async nextIdleTile(): Promise<void> {
    this.idleGenerating = true;
    const seed = IDLE_SEEDS[this.idleIndex % IDLE_SEEDS.length]!;
    this.idleIndex += 1;
    try {
      const tile = await generateTile(seed);
      if (!this.idleCtx) {
        tile.bitmap.close();
        return;
      }
      const pattern = this.idleCtx.createPattern(tile.bitmap, 'repeat');
      if (!pattern) {
        tile.bitmap.close();
        return;
      }
      if (!this.idleCurrent) {
        this.idleCurrent = tile.bitmap;
        this.idleCurrentPattern = pattern;
        this.idleCycleStart = performance.now();
      } else {
        this.idleNext = tile.bitmap;
        this.idleNextPattern = pattern;
        this.idleFadeStart = performance.now();
      }
    } catch (error) {
      console.warn('[stage] 유휴 패턴 생성 실패 — 이전 패턴을 유지합니다', error);
    } finally {
      this.idleGenerating = false;
    }
  }

  private paintIdle(now: number): void {
    const ctx = this.idleCtx;
    if (!ctx || !this.idleCurrentPattern) return;

    const drift = this.reduceMotion ? 0 : now * IDLE_DRIFT;
    ctx.clearRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

    this.fillIdle(ctx, this.idleCurrentPattern, drift, 1);

    if (this.idleNextPattern) {
      const progress = Math.min(1, (now - this.idleFadeStart) / IDLE_FADE_MS);
      this.fillIdle(ctx, this.idleNextPattern, drift, progress);
      if (progress >= 1) {
        this.idleCurrent?.close();
        this.idleCurrent = this.idleNext;
        this.idleCurrentPattern = this.idleNextPattern;
        this.idleNext = null;
        this.idleNextPattern = null;
        this.idleCycleStart = now;
      }
    }
  }

  private fillIdle(
    ctx: CanvasRenderingContext2D,
    pattern: CanvasPattern,
    drift: number,
    alpha: number,
  ): void {
    const scale = IDLE_TILE_PX / 1024;
    pattern.setTransform(
      new DOMMatrix().translateSelf(-drift * 0.4, -drift).scaleSelf(scale, scale),
    );
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
    ctx.restore();
  }

  // ── 내부: 장면 조립 ────────────────────────────
  /** ATTRACT — 로고·브랜드 문자 없이 "여기 서 보세요" 하나만 말한다(가드레일). */
  private buildAttract(): HTMLDivElement {
    const scene = el('div', 'stageScene stageScene--attract');
    scene.append(
      el('div', 'stageMark'),
      text('p', 'stageHeadline', '다가와서 서 보세요'),
      text('p', 'stageSub', '당신의 색과 움직임이 지금 이 패턴으로 태어납니다'),
      el('div', 'stageFootmark'),
    );
    return scene;
  }

  private buildConsent(): HTMLDivElement {
    const scene = el('div', 'stageScene stageScene--consent');
    const card = el('div', 'stageCard');

    const bullets = el('div', 'stageBullets');
    bullets.append(
      bullet('패턴을 만드는 동안에만 카메라 영상을 사용합니다.'),
      bullet('원본 영상·사진은 저장하지 않습니다. 화면을 떠나면 즉시 파기됩니다.', true),
      bullet('만들어진 패턴 영상만 QR 링크로 전달됩니다.'),
    );

    const agree = button('동의하고 시작', 'stageBtn stageBtn--primary', () =>
      this.consentHandler(true),
    );
    agree.id = 'btnConsentAgree';
    const decline = button('아니요', 'stageBtn', () => this.consentHandler(false));
    decline.id = 'btnConsentDecline';

    const actions = el('div', 'stageActions');
    actions.append(agree, decline);

    card.append(
      text('p', 'stageEyebrow', '카메라 사용 동의'),
      text('p', 'stageHeadline', '카메라를 사용해도 될까요?'),
      bullets,
      actions,
      text('p', 'stageCountdown', ''),
    );
    scene.append(card);
    return scene;
  }

  private buildProgress(): HTMLDivElement {
    const scene = el('div', 'stageScene stageScene--progress');
    const seed = el('div', 'stageSeed');
    seed.append(el('span', 'stageSeedChip'), el('span', 'stageSeedChip'), el('span', 'stageSeedChip'));
    scene.append(seed, text('p', 'stageHeadline', ''), text('p', 'stageSub', ''));
    return scene;
  }

  private buildOwn(resultCard: HTMLElement): HTMLDivElement {
    const scene = el('div', 'stageScene stageScene--own');
    const card = el('div', 'stageCard');
    scene.append(card, resultCard);
    return scene;
  }

  private buildNotice(): HTMLDivElement {
    const scene = el('div', 'stageScene stageScene--notice');
    const card = el('div', 'stageCard');
    card.append(
      text('p', 'stageEyebrow', ''),
      text('p', 'stageHeadline', ''),
      text('p', 'stageSub', ''),
      text('p', 'stageOpsHint', ''),
    );
    scene.append(card);
    return scene;
  }

  /** 폴백 레이어 — 영상이 재생되면 플레이스홀더를 덮고, 실패하면 플레이스홀더가 남는다. */
  private buildFallback(): HTMLDivElement {
    const layer = el('div', 'stageFallback');
    layer.hidden = true;

    const video = el('video', 'stageFallbackVideo');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.onplaying = () => {
      video.classList.add('is-on');
      this.fallbackPlaceholder.hidden = true;
    };
    video.onerror = () => {
      video.classList.remove('is-on');
      this.fallbackPlaceholder.hidden = false;
    };

    const placeholder = el('div', 'stageFallbackPlaceholder');
    placeholder.append(
      text('p', 'stageEyebrow', '점검 중'),
      text('p', 'stageHeadline', '잠시 후 다시 만나요'),
      text('p', 'stageSub', '폴백 영상 준비 필요 — public/assets/fallback.mp4 (docs/OPERATIONS.md)'),
    );

    layer.append(video, placeholder);
    return layer;
  }

  private buildNameForm(defaultName: string): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'stageForm';
    form.id = 'patternNameForm';

    const input = document.createElement('input');
    input.className = 'stageInput';
    input.id = 'patternNameInput';
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = defaultName;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '패턴 이름');

    const submit = button('이름 짓고 결과 받기', 'stageBtn stageBtn--primary');
    submit.type = 'submit';
    submit.id = 'btnNameSubmit';

    form.append(input, submit);
    form.onsubmit = (event) => {
      event.preventDefault();
      this.nameHandler(input.value.trim() || defaultName);
    };
    return form;
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }
}

// ── 작은 DOM 도우미 ────────────────────────────
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const node = el(tag, className);
  node.textContent = content;
  return node;
}

function bullet(content: string, strong = false): HTMLParagraphElement {
  return text('p', strong ? 'stageBullet stageBullet--strong' : 'stageBullet', content);
}

function button(label: string, className: string, onClick?: () => void): HTMLButtonElement {
  const btn = el('button', className);
  btn.type = 'button';
  btn.textContent = label;
  if (onClick) {
    btn.onclick = (event) => {
      event.stopPropagation();
      onClick();
    };
  }
  return btn;
}
