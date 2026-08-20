/**
 * B · L2 생성AI 승격 프록시 (ADR-002)
 *
 * 키오스크가 FeatureSeed 를 보내면 Gemini 이미지 모델로 1024 타일을 생성해 돌려준다.
 * GEMINI_API_KEY 는 서버에만 있다 — 클라이언트 번들에 절대 넣지 않는다.
 *
 * 실패는 전부 5xx/4xx 로 끝난다: 클라이언트(promoteToL2)는 어떤 실패든 조용히
 * null 로 삼켜 L1 을 유지한다 (§5 L2 승격 프로토콜 — "무반응이 정답").
 *
 * 프롬프트 주의: 실브랜드 연상 어휘("monogram", 패션 하우스 명 등)는 모델의
 * recitation 가드에 걸린다(실측). 순수 기하 묘사만 쓴다. 문자·로고 금지는 계약.
 */
const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};

const GEMINI_API_KEY = env.GEMINI_API_KEY;
const GEMINI_MODEL = env.GEMINI_L2_MODEL ?? 'gemini-3.1-flash-lite-image';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
/** 서버측 생성 상한 — 클라이언트 예산(8s)보다 짧게 잡아 응답 전송 여유를 남긴다. */
const GENERATION_TIMEOUT_MS = 6500;

/** 공개 엔드포인트가 유료 API 를 부르므로 최소한의 전역 브레이크. */
const RATE_LIMIT_PER_MINUTE = 12;
let windowStart = 0;
let windowCount = 0;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function POST(request: Request): Promise<Response> {
  return handler(request);
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }
  if (!GEMINI_API_KEY) {
    return json({ error: 'L2 is not configured.' }, 503);
  }

  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (++windowCount > RATE_LIMIT_PER_MINUTE) {
    return json({ error: 'Too many pattern generations. Try again shortly.' }, 429);
  }

  let seed: { dominantColors: string[]; motionEnergy: number };
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const colors = body.dominantColors;
    const motion = Number(body.motionEnergy);
    if (
      !Array.isArray(colors) ||
      colors.length !== 3 ||
      !colors.every((c) => typeof c === 'string' && HEX_COLOR.test(c)) ||
      !Number.isFinite(motion)
    ) {
      return json({ error: 'Invalid seed.' }, 400);
    }
    seed = { dominantColors: colors as string[], motionEnergy: Math.min(1, Math.max(0, motion)) };
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
  try {
    const upstream = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(buildRequest(seed)),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      return json({ error: 'Generation upstream failed.' }, 502);
    }
    const payload = (await upstream.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
    };
    const inline = payload.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!inline?.data) {
      // recitation 거부 등 — 이미지 없는 200. 클라이언트는 L1 유지.
      return json({ error: 'No image generated.' }, 502);
    }
    const binary = atob(inline.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': inline.mimeType ?? 'image/jpeg',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return json({ error: 'Generation timed out.' }, 504);
  } finally {
    clearTimeout(timer);
  }
}

/** 관객 시드를 반영한 탈브랜드 기하 프롬프트 — 실측으로 recitation 을 통과한 형태. */
function buildRequest(seed: { dominantColors: string[]; motionEnergy: number }) {
  const [c0, c1, c2] = seed.dominantColors;
  const density =
    seed.motionEnergy > 0.6
      ? 'densely packed with small motifs'
      : seed.motionEnergy > 0.3
        ? 'evenly spaced with medium motifs'
        : 'sparsely spaced with generous gaps between larger motifs';
  const text =
    'Create a SEAMLESS repeating geometric textile pattern tile (square, edges wrap perfectly for tiling). ' +
    'Base: warm cognac brown (#A9652C) flat canvas. ' +
    `Layout: orthogonal grid of small abstract geometric motifs — circular medallions, upright diamonds, and small rounded badge shapes — ${density}. ` +
    'Colors: dark chocolate (#3A2A18) and cream (#F2E7D2) motifs on the cognac base, ' +
    `with muted accents drawn from ${c0}, ${c1} and ${c2} used sparingly as small highlight fills (at most a third of motif colors). ` +
    'Strictly NO letters, NO characters, NO numbers, NO logos, NO text. ' +
    'Flat 2D vector illustration style, crisp clean edges, uniform flat colors, no gradients, no lighting, no shadow, no fabric texture, no noise.';
  return {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1' },
    },
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}
