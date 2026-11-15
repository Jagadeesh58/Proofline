import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config, userFacing } from '../config.mjs';
import { Store } from '../memory/store.mjs';
import { runTurn } from '../agent/run-turn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const PUBLIC = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const rateBuckets = new Map();

function getSessionId(request, response) {
  const cookie = request.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)proofline_session=([a-zA-Z0-9_-]+)/);
  let sessionId = match?.[1] || null;
  if (!sessionId) {
    sessionId = randomUUID();
    response.setHeader('Set-Cookie', `proofline_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return sessionId;
}

export function getClientIp(request) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const first = String(raw).split(',')[0].trim();
      if (first) return first;
    }
  }
  return request.socket?.remoteAddress || 'unknown';
}

function isAllowedHost(host, configHost) {
  const hostname = host.split(':')[0].toLowerCase();
  if (isLoopbackHost(configHost)) {
    return isLoopbackHost(hostname);
  }
  const allowed = process.env.ALLOWED_HOSTS
    ? process.env.ALLOWED_HOSTS.split(',').map((s) => s.trim().toLowerCase())
    : [];
  if (process.env.PUBLIC_ORIGIN) {
    try {
      const pub = new URL(
        process.env.PUBLIC_ORIGIN.startsWith('http')
          ? process.env.PUBLIC_ORIGIN
          : `https://${process.env.PUBLIC_ORIGIN}`
      );
      allowed.push(pub.hostname.toLowerCase());
    } catch { /* Ignore malformed PUBLIC_ORIGIN. */ }
  }
  if (!process.env.ALLOWED_HOSTS && !process.env.PUBLIC_ORIGIN) return true;
  return allowed.includes(hostname) || isLoopbackHost(hostname);
}

function securityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
      + "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  response.setHeader('cache-control', 'no-store');
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function isLoopbackHost(value) {
  const host = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

async function readBody(request, maxBytes = config.maxRequestBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
}

function allowedRate(request) {
  const ip = getClientIp(request);
  const now = Date.now();
  const current = rateBuckets.get(ip) || { start: now, count: 0 };
  if (now - current.start > config.rateWindowMs) { current.start = now; current.count = 0; }
  current.count += 1;
  rateBuckets.set(ip, current);
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) if (now - value.start > config.rateWindowMs) rateBuckets.delete(key);
  }
  return current.count <= config.rateLimitMax;
}

async function serveStatic(request, response, pathname) {
  let requested;
  try { requested = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); }
  catch { throw Object.assign(new Error('Malformed URL path.'), { status: 400 }); }
  const filePath = path.resolve(PUBLIC, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC}${path.sep}`) && filePath !== path.join(PUBLIC, 'index.html')) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const extension = path.extname(filePath);
  response.writeHead(200, { 'content-type': MIME[extension] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(response);
  return true;
}

export function seedDemoHistory(store, timezone = config.timezone) {
  try {
    const existing = store.listTurns(1000).filter((item) => item.is_demo);
    if (existing.length >= 3) return 0;
    const demoPath = path.join(ROOT, 'src/seeds/demo-history.json');
    if (!fs.existsSync(demoPath)) return 0;
    const demoTurns = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
    const missing = demoTurns.filter((item) => !existing.some((turn) => turn.user_text === item.user_text));
    if (!missing.length) return 0;
    const imported = store.importTurns(missing.map((item) => ({
      ...item, timezone, demo: true,
    })), timezone);
    return imported.length;
  } catch {
    return 0;
  }
}

export function createServer(
  store = new Store(config.dbPath),
  {
    beforeRequest = null,
    runTurnFn = runTurn,
    globalDailyBudget = null,
    sessionBudget = null,
  } = {}
) {
  if (config.demoMode || process.env.DEMO_MODE || process.env.RENDER || process.env.HOSTED) {
    seedDemoHistory(store, config.timezone);
  }
  let globalDailyCount = 0;
  let globalDailyDate = new Date().toISOString().slice(0, 10);
  const sessionCounts = new Map();

  function hasAvailableBudget(sessionId) {
    const maxGlobal = globalDailyBudget !== null ? globalDailyBudget : (
      Number(process.env.GLOBAL_DAILY_BUDGET) > 0 ? Number(process.env.GLOBAL_DAILY_BUDGET) : config.globalDailyBudget
    );
    const maxSession = sessionBudget !== null ? sessionBudget : (
      Number(process.env.SESSION_BUDGET) > 0 ? Number(process.env.SESSION_BUDGET) : config.sessionBudget
    );

    const today = new Date().toISOString().slice(0, 10);
    if (today !== globalDailyDate) {
      globalDailyDate = today;
      globalDailyCount = 0;
    }

    if (globalDailyCount >= maxGlobal) return false;
    const currentSessionCount = sessionCounts.get(sessionId) || 0;
    if (currentSessionCount >= maxSession) return false;
    return true;
  }

  function consumeBudget(sessionId) {
    globalDailyCount += 1;
    const currentSessionCount = sessionCounts.get(sessionId) || 0;
    sessionCounts.set(sessionId, currentSessionCount + 1);
  }

  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    try {
      if (beforeRequest) await beforeRequest(request);
      const host = request.headers.host || 'localhost';
      const url = new URL(request.url || '/', `http://${host}`);
      const pathname = url.pathname;
      if (pathname.startsWith('/api/') && !isAllowedHost(host, config.host)) {
        return json(response, 403, { error: 'Host header is not allowed.' });
      }
      if (request.method === 'GET' && (await serveStatic(request, response, pathname))) return;

      if (request.method === 'GET' && pathname === '/api/health') {
        return json(response, 200, {
          status: 'ok',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          ok: true,
          date: new Date().toISOString(),
          model: config.geminiModel,
          providers: {
            gemini: Boolean(config.geminiKey),
            tavily: Boolean(config.tavilyKey),
            search_backend: config.searchBackend,
          },
          storage: 'sqlite',
          recall: 'fts5',
          search_backend: config.searchBackend,
        });
      }

      if (request.method === 'GET' && pathname === '/api/config') {
        const isReplay = config.demoMode || config.searchBackend === 'replay';
        const replayMsg = 'Offline demo: scripted example answers. No AI model and no web search are used.';
        return json(response, 200, {
          model: isReplay && !config.geminiKey ? 'offline-demo' : config.geminiModel,
          timezone: config.timezone,
          demoMode: Boolean(config.demoMode),
          searchBackend: config.searchBackend,
          missing: { gemini: !config.geminiKey && !isReplay, tavily: !isReplay && !config.tavilyKey },
          messages: [
            isReplay ? replayMsg : (!config.geminiKey ? userFacing.missingGemini : null),
            !isReplay && !config.tavilyKey ? userFacing.missingTavily : null,
          ].filter(Boolean),
        });
      }

      if (request.method === 'GET' && pathname === '/api/history') {
        const sessionId = getSessionId(request, response);
        if (config.demoMode || process.env.DEMO_MODE || process.env.RENDER || process.env.HOSTED) {
          seedDemoHistory(store, config.timezone);
        }
        return json(response, 200, { turns: store.listTurns(100, sessionId) });
      }

      if (request.method === 'POST' && pathname.startsWith('/api/')) {
        const contentType = String(request.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
          return json(response, 415, { error: 'Content-Type must be application/json.' });
        }
        const originHeader = request.headers.origin || request.headers.referer;
        if (originHeader) {
          let originUrl;
          try { originUrl = new URL(originHeader); }
          catch { return json(response, 403, { error: 'Origin is not allowed.' }); }
          const originHost = originUrl.host.toLowerCase();
          const originHostname = originUrl.hostname.toLowerCase();
          const requestHostname = host.split(':')[0].toLowerCase();

          let allowedOrigin = originHost === host.toLowerCase();
          if (!allowedOrigin && isLoopbackHost(originHostname) && isLoopbackHost(requestHostname)) {
            allowedOrigin = true;
          }
          if (!allowedOrigin && process.env.PUBLIC_ORIGIN) {
            try {
              const pub = new URL(
                process.env.PUBLIC_ORIGIN.startsWith('http')
                  ? process.env.PUBLIC_ORIGIN
                  : `https://${process.env.PUBLIC_ORIGIN}`
              );
              if (originUrl.host.toLowerCase() === pub.host.toLowerCase()
                  || originUrl.origin.toLowerCase() === pub.origin.toLowerCase()) {
                allowedOrigin = true;
              }
            } catch { /* Ignore malformed PUBLIC_ORIGIN. */ }
          }
          if (!allowedOrigin) {
            return json(response, 403, { error: 'Cross-origin requests are not allowed.' });
          }
        }
      }

      if (request.method === 'POST' && pathname === '/api/import') {
        if (!allowedRate(request)) return json(response, 429, { error: 'Too many requests. Try again later.' });
        try {
          const body = await readBody(request);
          const turns = Array.isArray(body) ? body : body.turns;
          if (!Array.isArray(turns) || turns.length < 1 || turns.length > 1000) {
            return json(response, 400, { error: 'Import expects between 1 and 1,000 turns.' });
          }
          const validTurns = [];
          for (const item of turns) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              return json(response, 400, { error: 'Every imported turn must be an object.' });
            }
            const userLen = String(item.user_text ?? item.user ?? '').length;
            const assistantLen = String(item.assistant_text ?? item.assistant ?? '').length;
            if (userLen > 12_000 || assistantLen > 40_000) {
              return json(response, 400, { error: 'An imported turn exceeds the text limit.' });
            }
            validTurns.push(item);
          }
          store.importTurns(validTurns, body.timezone || config.timezone);
          const msg = `Imported ${validTurns.length} turn(s).`;
          return json(response, 200, { imported: validTurns.length, message: msg });
        } catch (error) { return json(response, error.status || 400, { error: error.message }); }
      }

      if (request.method === 'POST' && pathname === '/api/demo-history') {
        const existing = store.listTurns(1000).filter((item) => item.is_demo);
        if (existing.length >= 3) {
          return json(response, 200, { imported: 0, message: 'Demo history is already loaded.' });
        }
        const demoPath = path.join(ROOT, 'src/seeds/demo-history.json');
        const demoTurns = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
        const missing = demoTurns.filter((item) => !existing.some((turn) => turn.user_text === item.user_text));
        const imported = store.importTurns(missing.map((item) => ({
          ...item, timezone: config.timezone, demo: true,
        })), config.timezone);
        const msg = imported.length ? 'Three synthetic demo turns loaded.' : 'Demo history is already loaded.';
        return json(response, 200, { imported: imported.length, message: msg });
      }

      if (request.method === 'POST' && pathname === '/api/chat') {
        const sessionId = getSessionId(request, response);
        if (config.demoMode || process.env.DEMO_MODE || process.env.RENDER || process.env.HOSTED) {
          seedDemoHistory(store, config.timezone);
        }
        if (!hasAvailableBudget(sessionId)) {
          return json(response, 429, {
            error: 'Demo limit reached. Try running locally using the instructions in README.md.',
            message: 'Demo limit reached. Try running locally using the instructions in README.md.',
          });
        }
        if (!allowedRate(request)) return json(response, 429, { error: 'Too many requests. Try again later.' });
        let body;
        try { body = await readBody(request); }
        catch (error) { return json(response, error.status || 400, { error: error.message }); }
        if (typeof body.message !== 'string' || !body.message.trim()) {
          return json(response, 400, { error: 'Message is required.' });
        }
        if (body.message.length > 12_000) return json(response, 413, { error: 'Message is too long.' });
        consumeBudget(sessionId);

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        response.write('retry: 2500\n\n');
        const controller = new AbortController();
        response.on('close', () => {
          if (!response.writableEnded) controller.abort(new Error('Browser disconnected.'));
        });
        const send = (event, payload) => {
          if (response.destroyed || response.writableEnded) return;
          response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        try {
          await runTurnFn({
            userText: body.message,
            timezone: body.timezone || config.timezone,
            store,
            send,
            signal: controller.signal,
            sessionId,
          });
        } catch (error) {
          send('error', { message: error.message || 'The request failed.', code: 'request_error' });
        } finally {
          if (!response.writableEnded) response.end();
        }
        return;
      }

      json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = Number(error?.status) || 500;
      const message = status >= 500 ? 'The server could not complete this request.' : error.message;
      if (response.headersSent) {
        if (!response.writableEnded && !response.destroyed) {
          const errData = JSON.stringify({ message, status, provider_message: error.providerMessage || null });
          response.write(`event: error\ndata: ${errData}\n\n`);
          response.end();
        }
      } else {
        json(response, status, { error: message });
      }
    }
  });
  return server;
}
