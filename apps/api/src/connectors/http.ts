export class ConnectorAuthError extends Error {}
export class ConnectorError extends Error {
  constructor(message: string, public readonly status?: number) { super(message); }
}

export type HttpResult = { status: number; ok: boolean; json: any };
type Opts = {
  fetchFn?: typeof fetch;
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  /** Extra retry condition on a non-2xx response (e.g. Meta rate-limit codes sent with HTTP 400). */
  retryIf?: (r: HttpResult) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * JSON request with timeout and retry/backoff on network errors, 429, 5xx and caller-defined conditions.
 * Never includes request headers or URLs in thrown errors, so tokens cannot leak into logs.
 */
export async function requestJson(url: string, init: RequestInit, o: Opts = {}): Promise<HttpResult> {
  const { fetchFn = fetch, retries = 3, baseDelayMs = 500, timeoutMs = 30_000, retryIf, sleep = defaultSleep } = o;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      const result: HttpResult = { status: res.status, ok: res.ok, json };
      const retryable = !res.ok && (res.status === 429 || res.status >= 500 || retryIf?.(result));
      if (!retryable || attempt === retries) return result;
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw new ConnectorError(`Network error: ${lastErr instanceof Error ? lastErr.name : "unknown"}`);
}
