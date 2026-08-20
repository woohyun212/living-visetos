/**
 * A · 목 카메라 — getUserMedia 를 캔버스 스트림으로 바꿔치기한다.
 *
 * 같은 구현을 두 곳이 나눠 쓴다:
 *   - 개발 확인용 `?mockCamera=1` (main.ts, DEV 가드 안)
 *   - 운영자 **데모 모드** Shift+D (app/ops.ts) — ARCHITECTURE §9 폴백 매트릭스 '카메라 실패' 행
 *
 * 운영자 단축키는 **토글**이므로 install 은 되돌릴 수 있어야 한다. 되돌릴 때
 *   1) 페인트 루프(rAF)를 멈추고 2) 캔버스 스트림 트랙을 정지하고
 *   3) navigator.mediaDevices 를 원래대로 돌려놓는다.
 * (2·3 을 빠뜨리면 데모 모드를 껐는데도 GPU 가 계속 돌고 진짜 카메라가 돌아오지 않는다.)
 */

const MOCK_WIDTH = 960;
const MOCK_HEIGHT = 720;
const MOCK_FPS = 30;

/**
 * 지금 걸려 있는 바꿔치기. 두 종류를 구분해서 들고 있어야 한다 —
 * `?failCamera=1`(fail) 상태에서 운영자가 Shift+D 를 누르는 것이 폴백 리허설의 정확한 경로인데,
 * 하나로 묶어 두면 "이미 뭔가 걸려 있다"는 이유로 데모 모드가 켜지는 대신 꺼져 버린다.
 */
interface CameraOverride {
  kind: 'mock' | 'fail';
  restore(): void;
}

let active: CameraOverride | null = null;

export const isMockCameraActive = (): boolean => active?.kind === 'mock';

/**
 * getUserMedia 를 움직이는 캔버스 스트림으로 대체한다.
 * @returns 대체에 성공했는지 (captureStream 을 못 쓰는 브라우저면 false)
 */
export function installMockCamera(): boolean {
  if (active?.kind === 'mock') return true;
  // ?failCamera=1 로 거절 목이 걸려 있다면 먼저 걷는다 — 데모 모드가 그 위를 덮어야 한다.
  active?.restore();
  active = null;

  const canvas = document.createElement('canvas');
  canvas.width = MOCK_WIDTH;
  canvas.height = MOCK_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') {
    console.warn('[mock] 이 브라우저에서는 목 카메라를 만들 수 없습니다 (captureStream 미지원).');
    return false;
  }

  let raf = 0;
  let tick = 0;
  const paint = (): void => {
    tick += 1;
    ctx.fillStyle = `hsl(${(tick * 2) % 360} 55% 52%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `hsl(${(tick * 5 + 140) % 360} 70% 42%)`;
    ctx.beginPath();
    ctx.arc(480 + Math.sin(tick / 9) * 170, 360 + Math.cos(tick / 12) * 90, 170, 0, Math.PI * 2);
    ctx.fill();
    raf = requestAnimationFrame(paint);
  };
  paint();

  /*
   * getUserMedia 는 부를 때마다 **새 스트림**을 준다. 하나를 재사용하면 안 된다 —
   * CaptureService.stop() 이 RESET 마다 트랙을 stop() 하므로, 같은 스트림을 다시 물린
   * 다음 관객은 죽은 트랙(videoWidth=2)을 받아 오버레이가 2×2 로 쪼그라든다.
   */
  const streams = new Set<MediaStream>();
  active = replaceMediaDevices(
    'mock',
    async () => {
      const stream = canvas.captureStream(MOCK_FPS);
      streams.add(stream);
      return stream;
    },
    () => {
      cancelAnimationFrame(raf);
      streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      streams.clear();
    },
  );

  console.info('[mock] getUserMedia 를 캔버스 스트림으로 대체했습니다.');
  return true;
}

/** 데모 모드 해제 — 진짜 카메라를 되돌려 놓는다. 켜져 있지 않으면 아무 일도 하지 않는다. */
export function uninstallMockCamera(): void {
  if (active?.kind !== 'mock') return;
  active.restore();
  active = null;
}

/**
 * 개발 전용 — getUserMedia 가 항상 거절하게 만든다 (`?failCamera=1`).
 * 폴백 매트릭스 '카메라 실패' 행을 카메라를 물리적으로 가리지 않고 재현하기 위한 계기다.
 * 프로덕션 번들에서는 호출부가 `import.meta.env.DEV` 가드 안에 있어 통째로 제거된다.
 */
export function installFailingCamera(): void {
  if (active) return;
  active = replaceMediaDevices('fail', async () => {
    throw new DOMException('Requested device not found', 'NotFoundError');
  });
  console.info('[mock] getUserMedia 가 항상 실패하도록 만들었습니다 (?failCamera=1).');
}

/**
 * navigator.mediaDevices 를 통째로 갈아 끼우고, 되돌리는 손잡이를 돌려준다.
 * mediaDevices 는 보통 프로토타입의 getter 라 own 프로퍼티가 없다 — 그 경우 되돌리기는
 * own 프로퍼티를 지워 프로토타입 getter 를 다시 드러내는 것이다.
 */
function replaceMediaDevices(
  kind: CameraOverride['kind'],
  getUserMedia: MediaDevices['getUserMedia'],
  onRestore?: () => void,
): CameraOverride {
  const realDevices = navigator.mediaDevices as MediaDevices | undefined;
  const realGetUserMedia = realDevices?.getUserMedia.bind(realDevices);
  const ownDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  const fake = { getUserMedia } as unknown as MediaDevices;
  let replacedProperty = false;
  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: fake });
    replacedProperty = true;
  } catch {
    // 프로퍼티를 못 바꾸는 브라우저 — 메서드만 갈아 끼운다.
    navigator.mediaDevices.getUserMedia = getUserMedia;
  }

  return {
    kind,
    restore(): void {
      onRestore?.();
      if (replacedProperty) {
        if (ownDescriptor) Object.defineProperty(navigator, 'mediaDevices', ownDescriptor);
        else Reflect.deleteProperty(navigator, 'mediaDevices');
      } else if (realGetUserMedia) {
        navigator.mediaDevices.getUserMedia = realGetUserMedia;
      }
    },
  };
}
