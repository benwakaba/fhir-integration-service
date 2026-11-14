// Minimal FHIR REST client for pulling from source servers: JSON only, a
// per-request timeout that also covers reading the body, and bounded retries
// with exponential backoff for throttling, gateway errors and network failures.
// Retry-After is honored when the server sends it.

import { setTimeout as sleep } from 'node:timers/promises';

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export class FhirHttpError extends Error {
  constructor(status, url, body) {
    const detail = body?.issue?.[0]?.diagnostics ?? body?.issue?.[0]?.details?.text;
    super(`${status} from ${url}${detail ? `: ${detail}` : ''}`);
    this.name = 'FhirHttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export function createFhirClient({
  baseUrl,
  timeoutMs = 30_000,
  maxRetries = 4,
  baseDelayMs = 500,
  fetchImpl = globalThis.fetch,
  log,
}) {
  const base = baseUrl.replace(/\/+$/, '');

  async function request(url, { headers = {} } = {}) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/fhir+json', 'user-agent': 'fhir-integration-service/0.1', ...headers },
          signal: controller.signal,
        });
        if (response.status === 304) return { status: 304, headers: response.headers, body: null };
        if (RETRYABLE.has(response.status) && attempt < maxRetries) {
          const wait = retryAfterMs(response.headers.get('retry-after')) ?? backoff(attempt, baseDelayMs);
          log?.warn('source throttled or failing; retrying', { status: response.status, attempt: attempt + 1, waitMs: wait });
          await response.body?.cancel();
          await sleep(wait);
          continue;
        }
        const text = await response.text();
        const body = text ? JSON.parse(text) : null;
        if (!response.ok) throw new FhirHttpError(response.status, url, body);
        return { status: response.status, headers: response.headers, body };
      } catch (err) {
        if (err instanceof FhirHttpError || err instanceof SyntaxError) throw err;
        if (attempt >= maxRetries) {
          if (err.name === 'AbortError') throw new Error(`Timed out after ${timeoutMs}ms: ${url}`, { cause: err });
          // fetch reports every network failure as "fetch failed"; the cause says which.
          throw new Error(`${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''} after ${attempt + 1} attempts: ${url}`, { cause: err });
        }
        const wait = backoff(attempt, baseDelayMs);
        log?.warn('request failed; retrying', { error: err.cause?.code ?? err.message, attempt: attempt + 1, waitMs: wait });
        await sleep(wait);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return {
    baseUrl: base,
    /** Absolute URL for a search on this server. */
    searchUrl(type, params = {}) {
      const query = new URLSearchParams(params).toString();
      return `${base}/${type}${query ? `?${query}` : ''}`;
    },
    async getJson(url) {
      return (await request(url)).body;
    },
    /** Conditional read: pass the ETag we hold and get { status: 304 } when nothing changed. */
    read(type, id, { ifNoneMatch } = {}) {
      return request(`${base}/${type}/${encodeURIComponent(id)}`, {
        headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
      });
    },
  };
}

function backoff(attempt, baseDelayMs) {
  const exp = Math.min(30_000, baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}

function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(60_000, date - Date.now()));
}
