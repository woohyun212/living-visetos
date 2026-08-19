import type { ViteDevServer } from 'vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [localResultsApiPlugin()],
  build: {
    rollupOptions: {
      input: {
        kiosk: 'index.html',
        admin: 'admin.html',
      },
    },
  },
});

function localResultsApiPlugin() {
  return {
    name: 'living-visetos-local-results-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/results', async (request, response) => {
        try {
          const api = await import('./api/results.ts');
          const webResponse = await api.default.fetch(
            toWebRequest(request as unknown as LocalApiRequest),
          );
          response.statusCode = webResponse.status;
          webResponse.headers.forEach((value, key) => {
            response.setHeader(key, value);
          });
          response.end(await webResponse.text());
        } catch {
          response.statusCode = 500;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ error: 'Local results API failed.' }));
        }
      });
    },
  };
}

type LocalApiRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  readable: boolean;
};

function toWebRequest(request: LocalApiRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/api/results', 'http://localhost').toString();
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { headers, method });
  }

  return new Request(url, {
    body: request.readable ? request : null,
    duplex: 'half',
    headers,
    method,
  } as RequestInit & { duplex: 'half' });
}
