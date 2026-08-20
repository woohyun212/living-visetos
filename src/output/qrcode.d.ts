/**
 * qrcode(MIT) 브라우저 렌더러의 최소 타입 선언.
 *
 * @types/qrcode 를 쓰지 않는 이유: 그 패키지가 @types/node 를 끌고 들어오면서
 * DOM 전역(setTimeout 등)을 Node 시그니처로 덮어써 recorder.ts 가 깨진다.
 * 우리가 실제로 쓰는 toCanvas 하나만 직접 선언해 오염 없이 쓴다.
 */
declare module 'qrcode' {
  export interface QRCodeToCanvasOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    color?: { dark?: string; light?: string };
  }

  export function toCanvas(
    canvas: HTMLCanvasElement,
    text: string,
    options?: QRCodeToCanvasOptions,
  ): Promise<void>;

  const qrcode: { toCanvas: typeof toCanvas };
  export default qrcode;
}
