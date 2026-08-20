/**
 * D · QR / Code — DeliveryTicket 을 관객이 가져갈 수 있는 형태로 바꾼다 (F-05, ARCHITECTURE §10).
 *
 * 오프라인 원칙: qrcode(MIT) 를 dependencies 로 로컬 번들한다. CDN 을 타지 않는다.
 * 여기서는 "무엇을 그릴지"만 책임지고, 화면 배치(DOM)는 AppShell(E) 이 맡는다.
 */
import QRCode from 'qrcode';

/** 스캔 가능 최소 크기 200px 위로 잡은 고정 렌더 크기. */
export const QR_SIZE_PX = 256;

/**
 * QR 에 실제로 넣을 절대 URL.
 * /api/results 는 RESULT_PUBLIC_BASE_URL 기준 절대 URL 을 주지만, 설정 누락 등으로
 * 상대 경로가 오면 폰 카메라에서 열 수 없다 — 항상 현재 origin 기준으로 절대화한다.
 */
export function toScannableUrl(url: string): string {
  try {
    return new URL(url, globalThis.location?.origin ?? 'http://localhost').href;
  } catch {
    return url;
  }
}

/** 화면에 글자로 보여줄 짧은 형태 — 스킴과 끝 슬래시를 덜어낸다. QR 페이로드로는 쓰지 않는다. */
export function toShortUrlLabel(url: string): string {
  return toScannableUrl(url)
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

/** 캔버스에 QR 을 그린다. 실패하면 던진다 — 호출부가 폴백 문구를 책임진다. */
export async function drawQrCode(canvas: HTMLCanvasElement, text: string): Promise<void> {
  await QRCode.toCanvas(canvas, text, {
    width: QR_SIZE_PX,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#222222ff', light: '#ffffffff' },
  });
}
