/**
 * Thin HTTP helper for data source handlers. Wraps `fetch` with:
 *   - timeout (default 30s — external providers are unpredictable)
 *   - user-agent stamping
 *   - structured 4xx/5xx classification (via thrown Error messages the
 *     executor's classifier recognizes)
 *
 * Why not axios: axios is already in deps via workers, but this module
 * lives backend-side where axios isn't universal. Native fetch keeps the
 * backend lighter and gives us AbortController for timeouts out of the box.
 */

const USER_AGENT = 'LeadreAI/1.0 (+https://leadreai.app)';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ProviderHttpInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Additional URL params merged into the request URL. */
  query?: Record<string, string | number | undefined>;
}

export interface ProviderHttpResponse<T> {
  status: number;
  data: T;
}

/**
 * Throws an Error whose .message starts with `HTTP <status>:` on non-2xx
 * responses, so the executor's `classifyError` catches auth_failed (401/403)
 * and rate_limited (429) correctly.
 */
export async function providerFetch<T = unknown>(
  url: string,
  init: ProviderHttpInit = {},
): Promise<ProviderHttpResponse<T>> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const u = new URL(url);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    ...init.headers,
  };
  if (init.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(u.toString(), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    let data: unknown;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => '');
    }

    if (!res.ok) {
      // Shape the error so the executor's classifier picks the right status.
      // We include the provider's own error body for the invocation log.
      const body = typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500);
      throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
    }

    return { status: res.status, data: data as T };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`HTTP timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
