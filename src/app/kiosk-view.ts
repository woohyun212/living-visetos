/**
 * E · KioskView — 상태머신이 화면에 드러나는 유일한 곳.
 *
 * 두 가지만 그린다.
 *   1) 풀스크린 오버레이 — ATTRACT / CONSENT / OWN(이름 짓기) / RESET / ERROR_RECOVER
 *   2) 상태 뱃지 — 지금 어떤 상태인지 작게 (요구사항 4)
 *
 * ⚠️ 오버레이는 반드시 position:fixed 로 **위에 덮는다**. 아래 그리드를 display:none 하면
 *    main.ts 의 canDeliver() 가 보는 overlayCanvas.offsetWidth 가 0이 되어 녹화가 조용히 막힌다.
 *
 * 디자인은 DESIGN.md 토큰(--ds-*)만 쓴다. 연출보다 구조가 목적이다.
 */
import type { KioskState } from '../contracts.ts';

export interface KioskViewOptions {
  /** false 면(?debug=1) 풀스크린 연출을 그리지 않는다. 이름 입력창과 상태 뱃지는 남는다. */
  chrome: boolean;
}

type Handler<T> = (value: T) => void;

const noop = (): void => {};

export class KioskView {
  private readonly root: HTMLDivElement;
  private readonly badge: HTMLDivElement;
  private readonly chrome: boolean;

  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  private attractHandler: Handler<void> = noop;
  private consentHandler: Handler<boolean> = noop;
  private nameHandler: Handler<string> = noop;

  constructor({ chrome }: KioskViewOptions) {
    this.chrome = chrome;

    this.root = document.createElement('div');
    this.root.className = 'kioskOverlay';
    this.root.id = 'kioskOverlay';
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    document.body.append(this.root);

    this.badge = document.createElement('div');
    this.badge.className = 'stateBadge';
    this.badge.id = 'stateBadge';
    this.badge.setAttribute('aria-label', '키오스크 상태');
    document.body.append(this.badge);
    this.renderBadge('ATTRACT', null);
  }

  onAttractTouch(fn: Handler<void>): void {
    this.attractHandler = fn;
  }

  onConsent(fn: Handler<boolean>): void {
    this.consentHandler = fn;
  }

  onNameSubmit(fn: Handler<string>): void {
    this.nameHandler = fn;
  }

  /** 상태 뱃지 — 남은 시간이 있으면 같이 보여준다. */
  renderBadge(state: KioskState, remainingMs: number | null): void {
    const left = remainingMs === null ? '' : ` · ${Math.ceil(remainingMs / 1000)}s`;
    this.badge.textContent = `상태 ${state}${left}`;
    this.badge.dataset['state'] = state;
  }

  hide(): void {
    this.stopCountdown();
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  showAttract(): void {
    if (!this.chrome) return this.hide();
    const card = this.panel('ATTRACT', '리빙 비세토스', '터치하여 시작', [
      '카메라 앞에 서면 당신만의 패턴이 태어납니다.',
    ]);
    this.open(card);
    this.root.classList.add('kioskOverlay--attract');
    this.root.onclick = () => this.attractHandler();
  }

  showConsent(totalMs: number, remaining: () => number | null): void {
    if (!this.chrome) return this.hide();
    const card = this.panel('CONSENT', '카메라를 사용합니다', '동의하시겠습니까?', [
      '패턴을 만드는 동안에만 카메라 영상을 사용합니다.',
      '원본 영상·사진은 저장하지 않습니다. 화면을 떠나면 즉시 파기됩니다.',
      '만들어진 패턴 영상만 QR 링크로 전달됩니다.',
    ]);

    const countdown = document.createElement('p');
    countdown.className = 'kioskCountdown';
    countdown.id = 'consentCountdown';
    countdown.textContent = `${Math.ceil(totalMs / 1000)}초 후 처음 화면으로 돌아갑니다`;

    const agree = this.button('동의하고 시작', 'kioskBtn kioskBtn--primary', () =>
      this.consentHandler(true),
    );
    agree.id = 'btnConsentAgree';
    const decline = this.button('거절', 'kioskBtn', () => this.consentHandler(false));
    decline.id = 'btnConsentDecline';

    const actions = document.createElement('div');
    actions.className = 'kioskActions';
    actions.append(agree, decline);
    card.append(countdown, actions);

    this.open(card);
    this.startCountdown(() => {
      const ms = remaining();
      if (ms === null) return;
      countdown.textContent = `${Math.ceil(ms / 1000)}초 후 처음 화면으로 돌아갑니다`;
    });
    agree.focus();
  }

  /** 진행 중 안내 — CREATE/TRANSFORM/MATERIALIZE 에서는 관객이 자기 모습을 봐야 하므로 얇게. */
  showProgress(state: KioskState, headline: string, note: string): void {
    if (!this.chrome) return this.hide();
    const card = this.panel(state, '만드는 중', headline, [note]);
    this.open(card, { thin: true });
  }

  /** OWN — 이름 짓기. 디버그 모드에서도 필요한 입력이므로 chrome 과 무관하게 그린다. */
  showNaming(defaultName: string): void {
    const card = this.panel('OWN', '이 패턴의 이름을 지어주세요', '나만의 이름으로 남습니다', [
      '입력한 이름이 결과 인증서(certificate.patternName)에 새겨집니다.',
    ]);

    const form = document.createElement('form');
    form.className = 'kioskForm';
    form.id = 'patternNameForm';

    const input = document.createElement('input');
    input.className = 'kioskInput';
    input.id = 'patternNameInput';
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = defaultName;
    input.setAttribute('aria-label', '패턴 이름');
    input.autocomplete = 'off';

    const submit = this.button('이름 짓고 결과 받기', 'kioskBtn kioskBtn--primary');
    submit.type = 'submit';
    submit.id = 'btnNameSubmit';

    form.append(input, submit);
    form.onsubmit = (event) => {
      event.preventDefault();
      this.nameHandler(input.value.trim() || defaultName);
    };

    card.append(form);
    this.open(card);
    input.focus();
  }

  /** 녹화·전송 중 — 입력을 걷고 기다리라고만 말한다. */
  showDelivering(patternName: string, seconds: number): void {
    const card = this.panel('OWN', `「${patternName}」`, `${seconds}초 동안 담고 있습니다`, [
      '잠시만 기다려주세요. 끝나면 QR 코드가 나타납니다.',
    ]);
    this.open(card, { thin: true });
  }

  /** 결과 카드(QR)는 본문에 있으므로 오버레이는 비켜준다. */
  showResult(): void {
    this.hide();
  }

  showFarewell(): void {
    if (!this.chrome) return this.hide();
    const card = this.panel('RESET', '고맙습니다', '세션을 파기했습니다', [
      '방금 사용한 영상과 마스크는 이 순간 모두 지워졌습니다.',
    ]);
    this.open(card);
  }

  showError(message: string): void {
    if (!this.chrome) return this.hide();
    const card = this.panel('ERROR_RECOVER', '잠시 문제가 있었습니다', message, [
      '곧 처음 화면으로 돌아갑니다. 다시 시도해주세요.',
    ]);
    this.open(card);
  }

  dispose(): void {
    this.stopCountdown();
    this.root.remove();
    this.badge.remove();
  }

  // ── 내부 ──────────────────────────────────────
  private panel(
    state: KioskState,
    eyebrow: string,
    headline: string,
    notes: string[],
  ): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'kioskCard';

    const eyebrowEl = document.createElement('p');
    eyebrowEl.className = 'kioskEyebrow';
    eyebrowEl.textContent = `${state} · ${eyebrow}`;

    const headlineEl = document.createElement('p');
    headlineEl.className = 'kioskHeadline';
    headlineEl.textContent = headline;

    card.append(eyebrowEl, headlineEl);
    for (const note of notes) {
      const noteEl = document.createElement('p');
      noteEl.className = 'kioskNote';
      noteEl.textContent = note;
      card.append(noteEl);
    }
    return card;
  }

  private button(label: string, className: string, onClick?: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    if (onClick) {
      btn.onclick = (event) => {
        event.stopPropagation();
        onClick();
      };
    }
    return btn;
  }

  private open(card: HTMLDivElement, { thin = false } = {}): void {
    this.stopCountdown();
    this.root.onclick = null;
    this.root.classList.remove('kioskOverlay--attract');
    this.root.classList.toggle('kioskOverlay--thin', thin);
    this.root.replaceChildren(card);
    this.root.hidden = false;
  }

  private startCountdown(tick: () => void): void {
    this.countdownTimer = setInterval(tick, 500);
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }
}
