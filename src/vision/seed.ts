/**
 * A · SeedExtractor (F-01)
 * 스켈레톤 `extractSeed()` 그대로 이식 — 담당자는 이 함수만 고도화하면 된다.
 *
 * 출력 계약: FeatureSeed { dominantColors[3], motionEnergy 0~1, rhythm 0~1, sessionId }
 * DoD(DEV_SETUP §2): 조명 변화에도 안정적인 색·모션 추출.
 */
import type { FeatureSeed } from '../contracts.ts';

const FRAME_GAP_MS = 350; // 두 프레임 간격
const FALLBACK_COLOR = '#A9652C'; // 꼬냑 — 색 추출 실패 시

export interface ExtractSeedOptions {
  sessionId: string;
  frameGapMs?: number;
}

export async function extractSeed(
  video: HTMLVideoElement,
  { sessionId, frameGapMs = FRAME_GAP_MS }: ExtractSeedOptions,
): Promise<FeatureSeed> {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 72;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!x) throw new Error('2D 컨텍스트를 만들 수 없습니다');

  x.drawImage(video, 0, 0, c.width, c.height);
  const f1 = x.getImageData(0, 0, c.width, c.height).data;
  await new Promise((r) => setTimeout(r, frameGapMs));
  x.drawImage(video, 0, 0, c.width, c.height);
  const f2 = x.getImageData(0, 0, c.width, c.height).data;

  // 모션 에너지: 프레임 차분 평균
  let diff = 0;
  for (let i = 0; i < f1.length; i += 16) diff += Math.abs(f1[i]! - f2[i]!);
  const motionEnergy = Math.min(1, diff / (f1.length / 16) / 38);

  // 주요 색: 12단계 양자화 후 상위 3개 (극단적 명암은 제외)
  const bins: Record<string, number> = {};
  for (let i = 0; i < f2.length; i += 8) {
    const r = f2[i]!,
      g = f2[i + 1]!,
      b = f2[i + 2]!;
    const lum = (r + g + b) / 3;
    if (lum < 28 || lum > 236) continue;
    const k = [r, g, b].map((v) => Math.round(v / 24) * 24).join(',');
    bins[k] = (bins[k] ?? 0) + 1;
  }
  const colors = Object.entries(bins)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) =>
      '#' +
      k
        .split(',')
        .map((n) => (+n).toString(16).padStart(2, '0'))
        .join(''),
    );
  while (colors.length < 3) colors.push(FALLBACK_COLOR);

  return {
    dominantColors: [colors[0]!, colors[1]!, colors[2]!],
    motionEnergy: +motionEnergy.toFixed(2),
    rhythm: +(0.3 + motionEnergy * 0.7).toFixed(2),
    sessionId,
  };
}
