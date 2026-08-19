import type { PreviewServer, ViteDevServer } from 'vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [localResultsApiPlugin()],
  build: {
    rollupOptions: {
      input: {
        kiosk: 'index.html',
        admin: 'admin.html',
        result: 'result.html',
      },
    },
  },
});

function localResultsApiPlugin() {
  return {
    name: 'living-visetos-local-results-api',
    configureServer(server: ViteDevServer) {
      installLocalResultMiddlewares(server);
    },
    configurePreviewServer(server: PreviewServer) {
      installLocalResultMiddlewares(server);
    },
  };
}

type LocalMiddlewareServer = Pick<ViteDevServer | PreviewServer, 'middlewares'>;

function installLocalResultMiddlewares(server: LocalMiddlewareServer): void {
  server.middlewares.use('/api/results', async (request, response) => {
    try {
      const api = await import('./api/results.ts');
      await sendWebResponse(response, await api.default.fetch(
        toWebRequest(request as unknown as LocalApiRequest, '/api/results'),
      ));
    } catch (error) {
      sendLocalApiFailure(response, 'Local results API failed.', error);
    }
  });

  server.middlewares.use('/api/orders', async (request, response) => {
    try {
      const api = await import('./api/orders.ts');
      await sendWebResponse(response, await api.default.fetch(
        toWebRequest(request as unknown as LocalApiRequest, '/api/orders'),
      ));
    } catch (error) {
      sendLocalApiFailure(response, 'Local orders API failed.', error);
    }
  });

  server.middlewares.use((request, _response, next) => {
    const localRequest = request as unknown as { url?: string };
    const url = new URL(localRequest.url ?? '/', 'http://localhost');
    if (url.pathname === '/results' || url.pathname.startsWith('/results/')) {
      localRequest.url = `/result.html${url.search}`;
    }

    next();
  });
}

type LocalApiRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  readable: boolean;
};

type LocalApiResponse = {
  statusCode: number;
  setHeader(key: string, value: string): void;
  end(body: string): void;
};

function toWebRequest(request: LocalApiRequest, fallbackPath: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(', '));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? fallbackPath, 'http://localhost').toString();
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

async function sendWebResponse(
  response: LocalApiResponse,
  webResponse: Response,
): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });
  response.end(await webResponse.text());
}

function sendLocalApiFailure(
  response: LocalApiResponse,
  fallback: string,
  error: unknown,
): void {
  const detail = error instanceof Error ? error.message : fallback;
  response.statusCode = 500;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: fallback, detail }));
}
