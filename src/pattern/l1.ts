/**
 * B · L1 ProceduralEngine (F-02)
 * 스켈레톤 `generateTile()` 이식 — 담당자는 이 함수만 갈아 끼운다.
 *
 * 가드레일 (변경 금지, DEV_SETUP §1 / skeleton 주석):
 *   - 브랜드 문자·로고를 절대 그리지 않는다.
 *   - 다이아 격자 리듬 고정, 꼬냑 기반 제한 팔레트.
 *   - 관객 색은 포인트로만 혼합 (ACCENT_MIX = 35%).
 *
 * 출력 계약: PatternTile { bitmap(1024px 반복 타일), version:'L1', meta }
 * DoD(DEV_SETUP §2): 문법 파라미터화(간격·밀도·모티프), 시드 고정 시 재현 가능.
 */
import type { FeatureSeed, PatternTile } from '../contracts.ts';

export const TILE_SIZE = 1024; // 계약: 1024px 반복 타일
const SCALE = TILE_SIZE / 512; // 스켈레톤은 512 기준으로 튜닝됨

// 제한 팔레트
const COGNAC = '#A9652C';
const DARK = '#3A2A18';
const CREAM = '#F2E7D2';
const ACCENT_MIX = 0.35; // 관객 색 혼합 상한

export function mix(hexA: string, hexB: string, t: number): string {
  const A = hexA.match(/\w\w/g)!.map((h) => parseInt(h, 16));
  const B = hexB.match(/\w\w/g)!.map((h) => parseInt(h, 16));
  return (
    '#' +
    A.map((a, i) => Math.round(a + (B[i]! - a) * t).toString(16).padStart(2, '0')).join('')
  );
}

/** 타일을 캔버스에 그린다 (프리뷰/텍스처 공용). 반환값은 meta. */
export function paintTile(
  canvas: HTMLCanvasElement,
  seed: FeatureSeed,
): PatternTile['meta'] {
  const x = canvas.getContext('2d');
  if (!x) throw new Error('2D 컨텍스트를 만들 수 없습니다');
  const W = canvas.width;

  const accent = mix(COGNAC, seed.dominantColors[0], ACCENT_MIX);
  const spacing = Math.round((46 - seed.motionEnergy * 18) * SCALE); // 움직임↑ = 밀도↑

  x.fillStyle = mix(COGNAC, CREAM, 0.12);
  x.fillRect(0, 0, W, W);
  x.lineWidth = 2.2 * SCALE;

  // 다이아 격자
  for (const dir of [1, -1]) {
    x.strokeStyle = mix(DARK, accent, 0.25);
    for (let i = -W; i < W * 2; i += spacing) {
      x.beginPath();
      x.moveTo(i, 0);
      x.lineTo(i + dir * W, W);
      x.stroke();
    }
  }

  // 교차점 모티프 (추상 로렐 점)
  for (let gx = 0; gx < W * 2; gx += spacing) {
    for (let gy = 0; gy < W * 2; gy += spacing) {
      const px = (gx - gy / 2) % W;
      const py = gy % W;
      const big = ((gx + gy) / spacing) % 3 === 0;
      x.fillStyle = big ? accent : mix(CREAM, seed.dominantColors[1], 0.3);
      x.beginPath();
      x.arc(px, py, (big ? 5.5 : 2.6) * SCALE, 0, Math.PI * 2);
      x.fill();
    }
  }

  return {
    palette: [COGNAC, accent, CREAM],
    spacing,
    motifDensity: +(TILE_SIZE / spacing).toFixed(2),
    seedRef: seed.dominantColors[0],
  };
}

/** 계약 산출물 생성. previewCanvas 를 주면 같은 그림을 화면에도 그려준다. */
export async function generateTile(
  seed: FeatureSeed,
  previewCanvas?: HTMLCanvasElement,
): Promise<PatternTile> {
  const off = document.createElement('canvas');
  off.width = off.height = TILE_SIZE;
  const meta = paintTile(off, seed);

  if (previewCanvas) {
    const px = previewCanvas.getContext('2d');
    px?.drawImage(off, 0, 0, previewCanvas.width, previewCanvas.height);
  }

  return { bitmap: await createImageBitmap(off), version: 'L1', meta };
}
