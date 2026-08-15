/**
 * A · SeedExtractor (F-01)
 *
 * 출력 계약: FeatureSeed { dominantColors[3], motionEnergy 0~1, rhythm 0~1, sessionId }
 * DoD(DEV_SETUP §2): 조명 변화에도 안정적인 색·모션 추출.
 *
 * v0 대비 고도화:
 *   - 색: 노출 정규화(프레임 평균 명도로 게인 보정) 후 HSV 양자화 히스토그램.
 *     채도 가중치로 무채색(벽·조명)이 상위를 먹는 것을 억제하고, 빈의 평균색으로 복원.
 *   - 마스크 샘플링: Segmenter 의 최신 마스크가 있으면 인물 영역만 샘플링(배경 배제).
 *   - 모션: 그레이스케일 + 프레임별 평균 명도 정규화 후 차분 → 전체 조도 변화(조명 깜빡임,
 *     자동 노출)가 모션으로 오인되지 않는다. 4프레임 3차분으로 리듬(변동성)도 실측.
 */
import type { FeatureSeed } from '../contracts.ts';
import type { Segmenter } from './segmenter.ts';

const SAMPLE_W = 96;
const SAMPLE_H = 72;
const FRAME_COUNT = 4; // 3개의 차분 → 모션 + 리듬
const FRAME_GAP_MS = 160; // 프레임 간격 (총 ~480ms, 예산 1.5s 이내)
const FALLBACK_COLOR = '#A9652C'; // 꼬냑 — 색 추출 실패 시

/** 노출 게인 목표 평균 명도(0~255)와 게인 클램프 — 과보정 방지 */
const TARGET_LUMA = 128;
const GAIN_MIN = 0.6;
const GAIN_MAX = 1.8;

/** 마스크 알파가 이 값 미만인 픽셀은 배경으로 보고 색 샘플에서 제외 */
const MASK_MIN_ALPHA = 0.35;

export interface ExtractSeedOptions {
  sessionId: string;
  frameGapMs?: number;
  /** 있으면 최신 마스크로 인물 영역만 색 샘플링 (없으면 전체 프레임) */
  segmenter?: Segmenter;
}

export async function extractSeed(
  video: HTMLVideoElement,
  { sessionId, frameGapMs = FRAME_GAP_MS, segmenter }: ExtractSeedOptions,
): Promise<FeatureSeed> {
  const t0 = performance.now();
  const c = document.createElement('canvas');
  c.width = SAMPLE_W;
  c.height = SAMPLE_H;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!x) throw new Error('2D 컨텍스트를 만들 수 없습니다');

  // 마스크는 프레임 수집과 병렬로 요청한다 (최초 1회는 모델 로딩 포함 — btnStart 에서 프리로드됨)
  const maskReady = segmenter?.send(video).catch(() => {});

  // ── 프레임 수집 ────────────────────────────────
  const frames: Uint8ClampedArray[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, frameGapMs));
    x.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    frames.push(x.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
  }
  await maskReady;

  // ── 인물 마스크 (있으면) — 알파 채널만 저해상도로 리샘플 ──
  let maskAlpha: Uint8ClampedArray | null = null;
  const maskBmp = segmenter?.latest;
  if (maskBmp) {
    x.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
    // 오버레이와 동일한 거울 정합 — 카메라 원본 프레임 좌표계로 되돌린다
    x.save();
    x.translate(SAMPLE_W, 0);
    x.scale(-1, 1);
    x.drawImage(maskBmp, 0, 0, SAMPLE_W, SAMPLE_H);
    x.restore();
    const d = x.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    maskAlpha = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H);
    for (let i = 0; i < maskAlpha.length; i++) maskAlpha[i] = d[i * 4 + 3]!;
  }

  // ── 모션: 정규화 그레이스케일 차분 ──────────────
  const grays = frames.map(toNormalizedGray);
  const diffs: number[] = [];
  for (let f = 1; f < grays.length; f++) {
    const a = grays[f - 1]!;
    const b = grays[f]!;
    let sum = 0;
    let weight = 0;
    for (let i = 0; i < a.length; i++) {
      const w = maskAlpha ? maskAlpha[i]! / 255 : 1;
      sum += Math.abs(a[i]! - b[i]!) * w;
      weight += w;
    }
    diffs.push(weight > 0 ? sum / weight : 0);
  }
  const meanDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const motionEnergy = clamp01(meanDiff / 22); // 22 ≈ 활발한 움직임의 평균 차분 (실측 스케일)

  // 리듬: 차분의 변동성(변동계수) — 일정한 흔들림 < 박자 있는 움직임
  const variance = diffs.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / diffs.length;
  const variability = meanDiff > 0.5 ? clamp01(Math.sqrt(variance) / meanDiff) : 0;
  const rhythm = clamp01(0.25 + 0.5 * motionEnergy + 0.25 * variability);

  // ── 색: 노출 정규화 + HSV 히스토그램 (마지막 프레임) ──
  const dominantColors = dominantFromFrame(frames[frames.length - 1]!, maskAlpha);

  console.info(
    `[perf] FeatureSeed 추출 ${Math.round(performance.now() - t0)}ms (예산 1500ms) · ` +
      `마스크샘플링=${maskAlpha ? 'ON' : 'OFF'} · diffs=[${diffs.map((d) => d.toFixed(1)).join(',')}]`,
  );

  return {
    dominantColors,
    motionEnergy: +motionEnergy.toFixed(2),
    rhythm: +rhythm.toFixed(2),
    sessionId,
  };
}

/** RGBA → 그레이스케일, 프레임 평균 명도를 TARGET_LUMA 로 게인 보정 (조도 변화 상쇄). */
function toNormalizedGray(rgba: Uint8ClampedArray): Float32Array {
  const n = rgba.length / 4;
  const g = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
    g[i] = v;
    sum += v;
  }
  const gain = clampGain(TARGET_LUMA / (sum / n || 1));
  for (let i = 0; i < n; i++) g[i] = g[i]! * gain;
  return g;
}

/** 노출 정규화 후 HSV 양자화 히스토그램에서 상위 3색 추출. */
function dominantFromFrame(
  rgba: Uint8ClampedArray,
  maskAlpha: Uint8ClampedArray | null,
): [string, string, string] {
  const n = rgba.length / 4;

  // 프레임 평균 명도 → 노출 게인 (색상 비율은 보존, 밝기만 정규화)
  let lumaSum = 0;
  for (let i = 0; i < n; i++) {
    lumaSum += (rgba[i * 4]! + rgba[i * 4 + 1]! + rgba[i * 4 + 2]!) / 3;
  }
  const gain = clampGain(TARGET_LUMA / (lumaSum / n || 1));

  // 빈: hue 15° × sat 3 × val 3 — 빈마다 보정된 RGB 합을 들고 평균색으로 복원한다
  const bins = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (let i = 0; i < n; i++) {
    if (maskAlpha && maskAlpha[i]! < MASK_MIN_ALPHA * 255) continue;
    const r = Math.min(255, rgba[i * 4]! * gain);
    const g = Math.min(255, rgba[i * 4 + 1]! * gain);
    const b = Math.min(255, rgba[i * 4 + 2]! * gain);
    const [h, s, v] = rgbToHsv(r, g, b);
    if (v < 0.12 || v > 0.96) continue; // 보정 후에도 극단 명암은 제외
    const key = (Math.floor(h / 15) << 4) | (Math.floor(s * 2.999) << 2) | Math.floor(v * 2.999);
    const bin = bins.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    const weight = 0.25 + 0.75 * s; // 채도 가중 — 무채색 벽이 1위를 먹지 않게
    bin.w += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
    bins.set(key, bin);
  }

  const top = [...bins.values()].sort((a, b) => b.w - a.w).slice(0, 3);
  const colors = top.map((bin) => rgbToHex(bin.r / bin.w, bin.g / bin.w, bin.b / bin.w));
  while (colors.length < 3) colors.push(FALLBACK_COLOR);
  return [colors[0]!, colors[1]!, colors[2]!];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max > 0 ? d / max : 0, max / 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
  );
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const clampGain = (v: number): number => Math.min(GAIN_MAX, Math.max(GAIN_MIN, v));
