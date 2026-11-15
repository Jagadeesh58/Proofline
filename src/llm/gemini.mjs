import { config } from '../config.mjs';
import { isReplayModelActive, replayJsonExtraction, replayStreamExecution } from './replay-provider.mjs';

export class ProviderError extends Error {
  constructor(message, status = 0, code = 'provider_error', retryAfterMs = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function endpoint(stream = false, model = config.geminiModel) {
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}`;
}

const modelThrottledUntil = new Map();

export function getCandidateModels() {
  const list = Array.isArray(config.geminiModels) && config.geminiModels.length
    ? config.geminiModels
    : [config.geminiModel, config.geminiFallbackModel].filter(Boolean);
  const models = list.length ? [...list] : ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];
  const now = Date.now();
  models.sort((a, b) => {
    const aThrottled = (modelThrottledUntil.get(a) || 0) > now ? 1 : 0;
    const bThrottled = (modelThrottledUntil.get(b) || 0) > now ? 1 : 0;
    return aThrottled - bThrottled;
  });
  return models;
}

function quotaExhaustionMessage(seconds = 20) {
  return `The Gemini rate limit or quota for this key is used up. Try again in about ${seconds} seconds, `
    + 'or set a different GEMINI_API_KEY or GEMINI_MODELS.';
}

const callTimestamps = [];

export function resetThrottle() {
  callTimestamps.length = 0;
  modelThrottledUntil.clear();
}

async function throttle(signal, onWait) {
  const limit = config.geminiRequestsPerMinute;
  if (!limit || limit <= 0) return;
  while (true) {
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    const now = Date.now();
    while (callTimestamps.length && callTimestamps[0] <= now - 60_000) {
      callTimestamps.shift();
    }
    if (callTimestamps.length < limit) {
      callTimestamps.push(now);
      return;
    }
    const delay = Math.max(50, callTimestamps[0] + 60_000 - now + 10);
    onWait?.(delay);
    await wait(delay, signal);
  }
}

function generationConfig({ json = false, thinkingLevel = null } = {}) {
  const value = { maxOutputTokens: 8192 };
  if (json) {
    value.responseMimeType = 'application/json';
  }
  const level = (thinkingLevel || config.geminiThinkingLevel || '').toLowerCase();
  if (level === 'off') {
    value.thinkingConfig = { thinkingBudget: 0 };
  } else if (level === 'high' || level === 'low') {
    value.thinkingConfig = { thinkingLevel: level.toUpperCase() };
  } else if (level === 'minimal') {
    value.thinkingConfig = { thinkingLevel: 'LOW' };
  } else if (level === 'medium') {
    value.thinkingConfig = { thinkingLevel: 'HIGH' };
  }
  if (Number.isFinite(config.geminiTemperature)) value.temperature = config.geminiTemperature;
  return value;
}

function logProviderError(provider, endpointName, status, message) {
  const safe = String(message || 'request failed').replace(/[\r\n]+/g, ' ').slice(0, 200);
  process.stderr.write(`${provider} ${endpointName} HTTP ${status}: ${safe}\n`);
}

async function parseError(response, endpointName = 'generateContent') {
  let body = '';
  try { body = await response.text(); } catch { /* The provider may close the response body. */ }
  let message = `Gemini request failed (${response.status}).`;
  try {
    const parsed = JSON.parse(body);
    const candidate = parsed?.error?.message;
    if (candidate) message = candidate.slice(0, 200);
  } catch { /* Provider payloads are never forwarded raw. */ }
  logProviderError('Gemini', endpointName, response.status, message);
  const code = response.status === 429
    ? 'quota'
    : response.status >= 500
      ? 'provider_unavailable'
      : 'provider_error';
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  return new ProviderError(message, response.status, code, retryAfter);
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function retryDelay(error) {
  const jitter = 400 + Math.floor(Math.random() * 801);
  return Math.min(5000, Math.max(jitter, error?.retryAfterMs || 0));
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

function addThinkingFallback(error, body) {
  if (error.status !== 400 || !body.generationConfig?.thinkingConfig) return false;
  const message = error.message.toLowerCase();
  return message.includes('thinking') || message.includes('unknown name') || message.includes('invalid argument');
}

async function postJson(body, signal, url = endpoint(false)) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await parseError(response, 'generateContent');
  const data = await response.json();
  if (data?.promptFeedback?.blockReason) {
    throw new ProviderError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}.`, 0, 'blocked_prompt');
  }
  if (!Array.isArray(data?.candidates) || !data.candidates.length) {
    throw new ProviderError('Gemini returned no candidates.', 0, 'empty_response');
  }
  return data;
}

function requestController(signal) {
  const controller = new AbortController();
  const timeoutMs = config.geminiTimeoutMs || 8_000;
  const timeout = setTimeout(
    () => controller.abort(new Error('Gemini request timed out.')),
    timeoutMs
  );
  const relayAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', relayAbort, { once: true });
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relayAbort);
    },
    controller,
  };
}

export async function generateStream({
  contents,
  systemInstruction,
  toolDeclaration,
  signal,
  recall,
  onText,
  onRetry,
  onStatus,
  onTiming,
}) {
  if (isReplayModelActive(config)) {
    return replayStreamExecution({ contents, systemInstruction, toolDeclaration, signal, recall, onText, onTiming });
  }
  if (!config.geminiKey) throw new ProviderError('Gemini API key is missing.', 0, 'missing_key');
  const candidateModels = getCandidateModels();
  let lastError = null;
  let totalRetries = 0;
  const streamStart = Date.now();
  let totalBackoffMs = 0;
  let totalThrottleMs = 0;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx += 1) {
    const activeModel = candidateModels[mIdx];
    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: generationConfig({ thinkingLevel: toolDeclaration ? 'low' : null }),
    };
    if (toolDeclaration) {
      body.tools = [{ functionDeclarations: [toolDeclaration] }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    }

    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      await throttle(signal, (delay) => { totalThrottleMs += delay; });
      const request = requestController(signal);
      let reader;
      let emitted = false;
      try {
        const response = await fetch(endpoint(true, activeModel), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
          body: JSON.stringify(body),
          signal: request.signal,
        });
        if (!response.ok) throw await parseError(response, 'streamGenerateContent');
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        const functionCalls = [];
        const chunks = [];
        const modelParts = [];
        const processData = (raw) => {
          const trimmed = raw.trim();
          if (!trimmed || trimmed === '[DONE]') return;
          let data;
          try { data = JSON.parse(trimmed); } catch { return; }
          if (data?.promptFeedback?.blockReason) {
            throw new ProviderError(
              `Gemini blocked the prompt: ${data.promptFeedback.blockReason}.`,
              0,
              'blocked_prompt'
            );
          }
          const parts = data?.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            modelParts.push(part);
            if (typeof part.text === 'string') {
              fullText += part.text;
              chunks.push(part.text);
              emitted = true;
              onText?.(part.text);
            }
            if (part.functionCall?.name) functionCalls.push(part.functionCall);
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) if (line.startsWith('data:')) processData(line.slice(5));
        }
        if (buffer.trim()) {
          for (const line of buffer.split(/\r?\n/)) if (line.startsWith('data:')) processData(line.slice(5));
        }
        if (!modelParts.length) throw new ProviderError('Gemini returned an empty stream.', 0, 'empty_response');
        const durationMs = Date.now() - streamStart;
        onTiming?.({
          type: 'stream',
          model: activeModel,
          duration_ms: durationMs,
          backoff_wait_ms: totalBackoffMs,
          throttle_wait_ms: totalThrottleMs,
          retries: totalRetries,
          status: response.status,
        });
        return {
          text: fullText,
          functionCalls,
          chunks,
          modelParts,
          retries: totalRetries,
          status: response.status,
          effectiveModel: activeModel,
          durationMs,
          backoffWaitMs: totalBackoffMs,
          throttleWaitMs: totalThrottleMs,
        };
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (request.controller.signal.aborted) throw new ProviderError('Gemini request timed out.', 0, 'timeout');
        if (emitted) {
          throw error;
        }

        if (addThinkingFallback(error, body) && attempt === 1) {
          delete body.generationConfig.thinkingConfig;
          attempt = 0;
          continue;
        }

        if (error instanceof ProviderError && error.status === 429) {
          if (callTimestamps.length) callTimestamps.pop();
          const waitMs = error.retryAfterMs ?? 5000;
          if (waitMs <= 2000 && attempt === 1) {
            if (totalBackoffMs + waitMs > (config.maxTurnBackoffMs || 10_000)) {
              break;
            }
            onRetry?.();
            totalRetries += 1;
            totalBackoffMs += waitMs;
            await wait(waitMs, signal);
            continue;
          }
          const cooloffMs = Math.max(10_000, error.retryAfterMs || 60_000);
          modelThrottledUntil.set(activeModel, Date.now() + cooloffMs);
          if (mIdx < candidateModels.length - 1) {
            const nextModel = candidateModels[mIdx + 1];
            onStatus?.(`Rate limit reached for ${activeModel}. Switched to fallback model ${nextModel}.`);
            onRetry?.();
            totalRetries += 1;
            break;
          }
          if (waitMs <= 20_000 && attempt === 1) {
            if (totalBackoffMs + waitMs > (config.maxTurnBackoffMs || 10_000)) {
              break;
            }
            const seconds = Math.max(1, Math.ceil(waitMs / 1000));
            onStatus?.(`Waiting for the model rate limit, about ${seconds} seconds`);
            onRetry?.();
            totalRetries += 1;
            totalBackoffMs += waitMs;
            await wait(waitMs, signal);
            continue;
          }
          break;
        }

        if (error instanceof ProviderError && error.status >= 500) {
          if (attempt === 1) {
            onRetry?.();
            totalRetries += 1;
            await wait(retryDelay(error), signal);
            continue;
          }
          throw error;
        }

        if (error instanceof ProviderError && error.status === 404) {
          break;
        }

        throw error;
      } finally {
        request.close();
        reader?.releaseLock?.();
      }
    }
  }

  onTiming?.({
    type: 'stream',
    model: candidateModels[candidateModels.length - 1],
    duration_ms: Date.now() - streamStart,
    backoff_wait_ms: totalBackoffMs,
    throttle_wait_ms: totalThrottleMs,
    retries: totalRetries,
    status: lastError?.status || 0,
    error: lastError?.message || null,
  });

  if (lastError?.status === 429 || lastError?.code === 'quota') {
    throw new ProviderError(quotaExhaustionMessage(20), 429, 'quota');
  }
  throw lastError || new ProviderError('Gemini request failed.', 0, 'provider_error');
}

export async function generateJson({ prompt, schema, signal, onRetry, onStatus, onTiming }) {
  if (isReplayModelActive(config)) {
    return replayJsonExtraction(prompt);
  }
  if (!config.geminiKey) throw new ProviderError('Gemini API key is missing.', 0, 'missing_key');
  const candidateModels = getCandidateModels();
  let lastError = null;
  const jsonStart = Date.now();
  let totalBackoffMs = 0;
  let totalThrottleMs = 0;

  for (let mIdx = 0; mIdx < candidateModels.length; mIdx += 1) {
    const activeModel = candidateModels[mIdx];
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { ...generationConfig({ json: true, thinkingLevel: 'low' }), responseSchema: schema },
    };

    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      await throttle(signal, (delay) => { totalThrottleMs += delay; });
      const request = requestController(signal);
      try {
        let data;
        try {
          data = await postJson(body, request.signal, endpoint(false, activeModel));
        } catch (postError) {
          if (addThinkingFallback(postError, body) && attempt === 1) {
            delete body.generationConfig.thinkingConfig;
            attempt = 0;
            continue;
          }
          throw postError;
        }
        const text = (data.candidates[0].content?.parts || []).map((part) => part.text || '').join('');
        if (!text.trim()) {
          throw new ProviderError('Gemini returned an empty structured response.', 0, 'empty_response');
        }
        try {
          const parsed = JSON.parse(text);
          const durationMs = Date.now() - jsonStart;
          onTiming?.({
            type: 'json',
            model: activeModel,
            duration_ms: durationMs,
            backoff_wait_ms: totalBackoffMs,
            throttle_wait_ms: totalThrottleMs,
            status: 200,
          });
          return parsed;
        } catch {
          throw new ProviderError('Gemini returned malformed structured output.', 0, 'malformed_output');
        }
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (request.controller.signal.aborted) throw new ProviderError('Gemini request timed out.', 0, 'timeout');

        if (error instanceof ProviderError && error.status === 429) {
          if (callTimestamps.length) callTimestamps.pop();
          const waitMs = error.retryAfterMs ?? 5000;
          if (waitMs <= 2000 && attempt === 1) {
            if (totalBackoffMs + waitMs > (config.maxTurnBackoffMs || 10_000)) {
              break;
            }
            onRetry?.();
            totalBackoffMs += waitMs;
            await wait(waitMs, signal);
            continue;
          }
          const cooloffMs = Math.max(10_000, error.retryAfterMs || 60_000);
          modelThrottledUntil.set(activeModel, Date.now() + cooloffMs);
          if (mIdx < candidateModels.length - 1) {
            const nextModel = candidateModels[mIdx + 1];
            onStatus?.(`Rate limit reached for ${activeModel}. Switched to fallback model ${nextModel}.`);
            onRetry?.();
            break;
          }
          if (waitMs <= 20_000 && attempt === 1) {
            if (totalBackoffMs + waitMs > (config.maxTurnBackoffMs || 10_000)) {
              break;
            }
            const seconds = Math.max(1, Math.ceil(waitMs / 1000));
            onStatus?.(`Waiting for the model rate limit, about ${seconds} seconds`);
            onRetry?.();
            totalBackoffMs += waitMs;
            await wait(waitMs, signal);
            continue;
          }
          break;
        }

        if (error instanceof ProviderError && error.status >= 500) {
          if (attempt === 1) {
            onRetry?.();
            await wait(retryDelay(error), signal);
            continue;
          }
          throw error;
        }

        if (error instanceof ProviderError && error.status === 404) {
          break;
        }

        throw error;
      } finally {
        request.close();
      }
    }
  }

  onTiming?.({
    type: 'json',
    model: candidateModels[candidateModels.length - 1],
    duration_ms: Date.now() - jsonStart,
    backoff_wait_ms: totalBackoffMs,
    throttle_wait_ms: totalThrottleMs,
    status: lastError?.status || 0,
    error: lastError?.message || null,
  });

  if (lastError?.status === 429 || lastError?.code === 'quota') {
    throw new ProviderError(quotaExhaustionMessage(20), 429, 'quota');
  }
  throw lastError || new ProviderError('Gemini request failed.', 0, 'provider_error');
}

export const webSearchDeclaration = {
  name: 'web_search',
  description: 'Search the web and retrieve relevant page text. Use targets for product pricing, '
    + 'plan limits, versions or news checks. Use queries for general research. '
    + 'The server assigns source IDs; cite those IDs only.',
  parameters: {
    type: 'OBJECT',
    properties: {
      queries: {
        type: 'ARRAY',
        maxItems: 6,
        items: {
          type: 'OBJECT',
          properties: {
            q: { type: 'STRING', minLength: 1, maxLength: 300 },
            topic: { type: 'STRING', enum: ['general', 'news'] },
            since: { type: 'STRING', description: 'YYYY-MM-DD; permitted only for news queries.' },
          },
          required: ['q'],
        },
      },
      targets: {
        type: 'ARRAY',
        maxItems: 6,
        items: {
          type: 'OBJECT',
          properties: {
            entity: {
              type: 'STRING',
              description: 'The exact company or product name only (e.g. "HubSpot", "Pipedrive", "Neon"). '
                + 'Do not include search words like "pricing" or years.',
            },
            checks: { type: 'ARRAY', items: { type: 'STRING', enum: ['pricing', 'limit', 'version', 'news'] } },
            since: {
              type: 'STRING',
              description: 'Required for news unless the server derives it from recalled history.',
            },
          },
          required: ['entity', 'checks'],
        },
      },
    },
  },
};
