/**
 * E · OperatorControls — 무대 모드 전용 운영자 단축키.
 *
 * ARCHITECTURE §9 폴백 매트릭스의 아래 세 행을 운영자 손에 쥐어 주는 층이다.
 *   Shift+D  목 카메라 데모 모드 토글   ('카메라 실패' → "운영자 안내 후 시연 계속")
 *   Shift+R  강제 RESET (세션 파기)      (관객 이탈·오작동 수습)
 *   Shift+F  전체 장애 폴백 화면 토글    ('전체 장애' → "사전 녹화 영상 재생 (단축키)")
 *
 * 화면에는 이 목록을 그리지 않는다 — 무대는 관객의 것이고, 유일한 문서는 README 운영 섹션이다.
 * (예외: ERROR_RECOVER 안내의 Shift+D 한 줄. 그 화면에서만 필요한 탈출구라서.)
 *
 * 두 가지 함정을 피해 간다.
 *   1) `event.code` 로 읽는다. 키오스크는 한국어 환경이고 한글 IME 가 켜져 있으면
 *      `event.key` 는 'ㅇ'·'ㄱ' 이 되어 단축키가 통째로 죽는다. code 는 자판 배열을 타지 않는다.
 *   2) OWN 은 #patternNameInput 에 자동 포커스한다 — 관객이 이름에 대문자를 치면 Shift 가 눌린다.
 *      그래서 입력 중에는 D·F 를 잠근다. R 만 예외다(수습 키가 정작 필요한 순간이 이름 입력 화면이다).
 */

import { installMockCamera, isMockCameraActive, uninstallMockCamera } from '../vision/mock-camera.ts';

export interface OperatorHooks {
  /** 데모 모드 표기 on/off — 관객에게 목 카메라임을 작게 알린다. */
  setDemoMode(on: boolean): void;
  /** 목 카메라가 켜진 직후 여정을 다시 민다. @returns 실제로 밀었는지 */
  resumeInDemoMode(): boolean;
  /** 어떤 상태에서든 세션을 파기한다 (RESET 을 통과해서). */
  forceReset(): void;
  showFallback(): void;
  hideFallback(): void;
}

/**
 * 단축키를 문서에 붙들어 둔다 — README 운영 섹션과 이 표가 어긋나면 그건 문서 버그다.
 * label 은 화면이 아니라 콘솔·문서용이다.
 */
export const OPERATOR_SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: 'Shift+D', label: '목 카메라 데모 모드 토글' },
  { keys: 'Shift+R', label: '강제 RESET (세션 파기)' },
  { keys: 'Shift+F', label: '전체 장애 폴백 화면 토글' },
];

/** 텍스트를 입력하는 중인가 — 관객의 이름 입력이 단축키로 새지 않게. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

/**
 * 단축키를 문서에 건다. 무대 모드(main.ts 의 `!DEBUG_MODE`)에서만 호출된다 —
 * "무대 모드 전용"이 조건문이 아니라 **호출 구조**로 지켜지도록.
 *
 * @returns 해제 함수
 */
export function installOperatorControls(hooks: OperatorHooks): () => void {
  let fallbackVisible = false;

  const setDemoMode = (on: boolean): void => {
    if (on) {
      if (!installMockCamera()) return; // 목 스트림을 못 만들면 아무 일도 없던 것으로
    } else {
      uninstallMockCamera();
    }
    hooks.setDemoMode(on);
    console.info(`[ops] 데모 모드 ${on ? 'ON' : 'OFF'} (목 카메라)`);
    if (on && !hooks.resumeInDemoMode()) {
      console.info('[ops] 체험이 진행 중이라 여정은 그대로 둡니다 — 다음 세션부터 목 카메라를 씁니다.');
    }
  };

  const setFallback = (on: boolean): void => {
    fallbackVisible = on;
    if (on) {
      // 폴백 화면 뒤에서 카메라가 계속 도는 것은 원칙 4 에 어긋난다 — 먼저 세션을 파기한다.
      hooks.forceReset();
      hooks.showFallback();
    } else {
      hooks.hideFallback();
    }
    console.info(`[ops] 전체 장애 폴백 화면 ${on ? 'ON' : 'OFF'}`);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;

    switch (event.code) {
      case 'KeyD':
        if (isTyping(event.target)) return;
        event.preventDefault();
        setDemoMode(!isMockCameraActive());
        break;

      case 'KeyR':
        // 입력 중에도 받는다 — 수습 키는 막히면 의미가 없다.
        event.preventDefault();
        if (fallbackVisible) setFallback(false);
        hooks.forceReset();
        console.info('[ops] 강제 RESET');
        break;

      case 'KeyF':
        if (isTyping(event.target)) return;
        event.preventDefault();
        setFallback(!fallbackVisible);
        break;

      default:
        break;
    }
  };

  addEventListener('keydown', onKeyDown);
  console.info(
    `[ops] 운영자 단축키 활성 — ${OPERATOR_SHORTCUTS.map((s) => `${s.keys} ${s.label}`).join(' · ')}`,
  );

  return () => {
    removeEventListener('keydown', onKeyDown);
    if (fallbackVisible) setFallback(false);
    if (isMockCameraActive()) setDemoMode(false);
  };
}
