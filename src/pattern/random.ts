import type { FeatureSeed } from '../contracts.ts';

/** FNV-1a 기반 32비트 문자열 해시. 브라우저 재시작 뒤에도 같은 결과를 낸다. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 결정적 PRNG. 비결정적 전역 난수를 사용하지 않는다. */
export function createDeterministicRandom(key: string): () => number {
  let state = hashString(key);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeedKey(seed: FeatureSeed): string {
  return [
    seed.sessionId,
    ...seed.dominantColors,
    seed.motionEnergy.toFixed(6),
    seed.rhythm.toFixed(6),
  ].join('|');
}
