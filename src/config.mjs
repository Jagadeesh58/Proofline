import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const number = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const configuredPrimary = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const configuredFallback = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const configuredModels = process.env.GEMINI_MODELS
  ? process.env.GEMINI_MODELS.split(',').map((s) => s.trim()).filter(Boolean)
  : [configuredPrimary, configuredFallback].filter(Boolean);

export const config = Object.freeze({
  host: process.env.HOST || '127.0.0.1',
  port: number('PORT', 3000),
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  dbPath: process.env.DB_PATH || 'data/chat-agent.sqlite',
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModels: configuredModels,
  geminiModel: configuredModels[0] || configuredPrimary,
  geminiFallbackModel: configuredModels[1] || configuredFallback,
  geminiRequestsPerMinute: number('GEMINI_REQUESTS_PER_MINUTE', 8),
  geminiThinkingLevel: (process.env.GEMINI_THINKING_LEVEL || 'low').toLowerCase(),
  geminiTemperature: process.env.GEMINI_TEMPERATURE === undefined || process.env.GEMINI_TEMPERATURE === ''
    ? null : Number(process.env.GEMINI_TEMPERATURE),
  maxExtractsPerQuery: Math.min(3, number('MAX_EXTRACTS_PER_QUERY', 1)),
  tavilyKey: process.env.TAVILY_API_KEY || '',
  searchBackend: process.env.SEARCH_BACKEND === 'replay' ? 'replay' : 'tavily',
  graderKey: process.env.EVAL_GRADER_API_KEY || '',
  graderModel: process.env.EVAL_GRADER_MODEL || '',
  graderBaseUrl: process.env.EVAL_GRADER_BASE_URL || '',
  maxRequestBytes: number('MAX_REQUEST_BYTES', 100_000),
  rateWindowMs: number('RATE_LIMIT_WINDOW_MS', 600_000),
  rateLimitMax: number('RATE_LIMIT_MAX', 30),
  maxContextTurns: number('MAX_CONTEXT_TURNS', 8),
  maxContextChars: number('MAX_CONTEXT_CHARS', 1500),
  maxToolRounds: Math.min(3, number('MAX_TOOL_ROUNDS', 3)),
  maxSearches: Math.min(14, number('MAX_TAVILY_SEARCHES', 14)),
  maxExtracts: Math.min(8, number('MAX_TAVILY_EXTRACTS', 8)),
  maxGeminiCalls: Math.min(10, number('MAX_GEMINI_CALLS', 10)),
  extractionMode: process.env.EXTRACTION_MODE === 'per_entity' ? 'per_entity' : 'batched',
  requestTimeoutMs: number('REQUEST_TIMEOUT_MS', 25_000),
  geminiTimeoutMs: 8_000,
  tavilySearchTimeoutMs: 4_000,
  tavilyExtractTimeoutMs: 5_000,
  maxTurnBackoffMs: 10_000,
});

export const userFacing = Object.freeze({
  missingGemini: 'Gemini is not configured. Add GEMINI_API_KEY to your local .env file to enable model answers.',
  missingTavily: 'Tavily is not configured. Add TAVILY_API_KEY to your local .env file to enable web search.',
  searchUnavailable: 'I could not verify this with web search, so I will not present it as a current fact.',
  genericFailure: 'The request could not be completed. Please try again.',
});

/** Replay is a complete local search backend; live mode needs a Tavily key. */
export function isSearchReady(settings = config) {
  return settings.searchBackend === 'replay' || Boolean(settings.tavilyKey);
}
