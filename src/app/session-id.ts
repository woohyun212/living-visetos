/**
 * 세션 ID 생성 — crypto.randomUUID() 는 보안 컨텍스트(HTTPS/localhost) 전용이라
 * 평문 HTTP 배포(예: http://<ip>:443)에서는 존재하지 않는다. getRandomValues 는
 * 비보안 컨텍스트에서도 동작하므로 UUID v4 를 직접 조립해 폴백한다.
 */
export function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
