import { config } from '../config.mjs';

export class TavilyError extends Error {
  constructor(message, status = 0, code = 'search_error', retryAfterMs = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function retryDelay(error) {
  return Math.min(5000, Math.max(400 + Math.floor(Math.random() * 801), error.retryAfterMs || 0));
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || new Error('Aborted'));
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 5 * 60_000;

export function resetSearchCache() {
  searchCache.clear();
}

async function request(endpoint, payload, signal, onRetry) {
  if (!config.tavilyKey) throw new TavilyError('Tavily API key is missing.', 0, 'missing_key');
  const cacheKey = `${endpoint}:${JSON.stringify(payload)}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return JSON.parse(JSON.stringify(cached.data));
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request timed out')), config.requestTimeoutMs);
    const relayAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      const response = await fetch(`https://api.tavily.com/${endpoint}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.tavilyKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { throw new TavilyError('Tavily returned malformed JSON.', response.status, 'malformed_output'); }
      if (!response.ok) {
        const status = response.status;
        const providerMessage = String(data?.detail?.error || data?.error || data?.message || '').slice(0, 200);
        const safeMsg = (providerMessage || 'request failed').replace(/[\r\n]+/g, ' ').slice(0, 200);
        process.stderr.write(`Tavily ${endpoint} HTTP ${status}: ${safeMsg}\n`);
        const code = status === 429 ? 'quota' : status >= 500 ? 'timeout' : 'search_error';
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        throw new TavilyError(
          `Tavily ${status}: ${providerMessage || 'request failed.'}`.slice(0, 220),
          status,
          code,
          retryAfter
        );
      }
      searchCache.set(cacheKey, { data, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });
      return data;
    } catch (error) {
      const retryable = error instanceof TavilyError && (error.status === 429 || error.status >= 500);
      if (retryable && attempt === 0 && !signal?.aborted) {
        onRetry?.();
        await wait(retryDelay(error), signal);
        continue;
      }
      if (error instanceof TavilyError || signal?.aborted) throw error;
      const timedOut = controller.signal.aborted && !signal?.aborted;
      const errCode = timedOut ? 'timeout' : 'network_error';
      const errMsg = timedOut ? 'Tavily request timed out.' : 'Tavily could not be reached.';
      throw new TavilyError(errMsg, 0, errCode);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relayAbort);
    }
  }
  throw new TavilyError('Tavily request failed after one retry.', 0, 'search_error');
}

export async function tavilySearch({ q, topic = 'general', since, includeRawContent = false, signal, onRetry }) {
  const payload = {
    query: q,
    search_depth: 'basic',
    max_results: 5,
    topic,
    include_raw_content: includeRawContent,
    include_answer: false,
  };
  if (topic === 'news' && since) payload.start_date = since;
  return request('search', payload, signal, onRetry);
}

export async function tavilyExtract(url, signal, onRetry) {
  return request('extract', {
    urls: [url],
    extract_depth: 'basic',
    format: 'markdown',
    include_favicon: false,
    include_images: false,
  }, signal, onRetry);
}
