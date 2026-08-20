const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
  .process?.env ?? {};
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_RESULTS_BUCKET = env.SUPABASE_RESULTS_BUCKET ?? 'results';
const RESULT_PUBLIC_BASE_URL = env.RESULT_PUBLIC_BASE_URL;

type ResultRecord = {
  code: string;
  session_id: string;
  pattern_name: string;
  issued_at: string;
  tile_meta: unknown;
  video_path: string;
  poster_path: string;
};

export const config = {
  runtime: 'nodejs',
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESULT_PUBLIC_BASE_URL) {
      return json({ error: 'Result storage is not configured.' }, 503);
    }

    try {
      const form = await request.formData();
      const sessionId = requireText(form, 'sessionId');
      const code = requireText(form, 'code');
      const certificate = parseCertificate(requireText(form, 'certificate'));
      const video = requireFile(form, 'video');
      const posterImage = requireFile(form, 'posterImage');
      const safeCode = code.replace(/[^A-Z0-9-]/gi, '').toUpperCase();
      if (!safeCode) {
        return json({ error: 'Missing result code.' }, 400);
      }
      const videoPath = `${safeCode}/clip.${extensionFor(video, 'webm')}`;
      const posterPath = `${safeCode}/poster.${extensionFor(posterImage, 'png')}`;

      await uploadToStorage(videoPath, video);
      await uploadToStorage(posterPath, posterImage);
      await insertResultRecord({
        code: safeCode,
        session_id: sessionId,
        pattern_name: certificate.patternName,
        issued_at: certificate.issuedAt,
        tile_meta: certificate.tileMeta,
        video_path: videoPath,
        poster_path: posterPath,
      });

      return json({ url: `${RESULT_PUBLIC_BASE_URL.replace(/\/$/, '')}/results/${safeCode}` }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Result upload failed.';
      return json({ error: message }, 400);
    }
  },
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function requireText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing form field: ${name}.`);
  }
  return value;
}

function requireFile(form: FormData, name: string): File {
  const value = form.get(name);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`Missing file field: ${name}.`);
  }
  return value;
}

function parseCertificate(value: string): { patternName: string; issuedAt: string; tileMeta: unknown } {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) {
    throw new Error('Invalid certificate payload.');
  }

  const { patternName, issuedAt, tileMeta } = parsed;
  if (typeof patternName !== 'string' || typeof issuedAt !== 'string') {
    throw new Error('Invalid certificate fields.');
  }

  return { patternName, issuedAt, tileMeta };
}

async function uploadToStorage(path: string, file: File): Promise<void> {
  const { serviceKey, url } = requireSupabaseConfig();
  const response = await fetch(
    `${url}/storage/v1/object/${SUPABASE_RESULTS_BUCKET}/${encodeURIComponentPath(path)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': file.type || 'application/octet-stream',
      },
      body: file,
    },
  );

  if (!response.ok) {
    throw new Error(`Storage upload failed: ${response.status}.`);
  }
}

async function insertResultRecord(record: ResultRecord): Promise<void> {
  const { serviceKey, url } = requireSupabaseConfig();
  const response = await fetch(`${url}/rest/v1/results`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(record),
  });

  if (!response.ok) {
    throw new Error(`Result record insert failed: ${response.status}.`);
  }
}

function requireSupabaseConfig(): { serviceKey: string; url: string } {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Result storage is not configured.');
  }
  return { serviceKey: SUPABASE_SERVICE_ROLE_KEY, url: SUPABASE_URL };
}

function extensionFor(file: File, fallback: string): string {
  if (file.type.includes('mp4')) return 'mp4';
  if (file.type.includes('png')) return 'png';
  if (file.type.includes('jpeg')) return 'jpg';
  if (file.type.includes('webm')) return 'webm';
  return fallback;
}

function encodeURIComponentPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
