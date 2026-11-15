import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const COMPETITOR_DIR = 'E:/competitor_audits/11';
const OUT_PATH = path.join(ROOT, 'evals/results/competitor-benchmark.json');
const PORT = 3088;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RUNS_PER_PROMPT = 5;

const PROMPTS = [
  {
    id: 'official-1',
    prompt: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. '
      + 'Has any of them changed pricing or shipped something big since?',
    check: (text) => /hubspot|pipedrive|zoho|monday|freshsales/i.test(text),
  },
  {
    id: 'official-2',
    prompt: 'What did I ask you on 3 November? Is your answer still correct today?',
    check: (text) => /postgres|database/i.test(text) && /3\s+nov|november/i.test(text),
  },
  {
    id: 'official-3',
    prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    check: (text) => /neon|supabase/i.test(text),
  },
];

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 20_000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/history`);
      if (res.ok) return true;
    } catch {
      // Waiting for server to bind
    }
    await sleep(500);
  }
  return false;
}

async function streamCompetitorChat(url, message) {
  const start = performance.now();
  let firstTokenTime = null;
  let answer = '';
  let hadError = false;
  let errorMessage = '';

  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'benchmark-session', message }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const elapsed = Math.round(performance.now() - start);
        if (parsed.type === 'token' && parsed.text) {
          if (firstTokenTime === null) firstTokenTime = elapsed;
          answer += parsed.text;
        } else if (parsed.text && firstTokenTime === null) {
          firstTokenTime = elapsed;
          answer += parsed.text;
        }
        if (parsed.type === 'error') {
          hadError = true;
          errorMessage = parsed.error || 'Competitor error event';
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  const totalTime = Math.round(performance.now() - start);
  if (hadError) throw new Error(`Stream error event: ${errorMessage}`);
  if (!answer.trim()) throw new Error('Empty answer received from competitor stream');

  return {
    status_code: res.status,
    first_token_ms: firstTokenTime,
    total_ms: totalTime,
    answer_length: answer.length,
    answer_preview: answer.slice(0, 160).replace(/[\r\n]+/g, ' '),
    answer,
  };
}

async function runBenchmark() {
  process.stdout.write('=== Competitor Benchmark: SanyamWadhwa07/minimi-chat-agent ===\n');

  if (!fs.existsSync(COMPETITOR_DIR)) {
    process.stderr.write(`Competitor directory not found: ${COMPETITOR_DIR}\n`);
    process.exit(1);
  }

  // Launch competitor server
  const child = spawn(
    'node',
    ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/server.ts'],
    {
      cwd: COMPETITOR_DIR,
      env: {
        ...process.env,
        PORT: String(PORT),
        GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
        GEMINI_FAST_MODEL: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (!s.includes('ExperimentalWarning')) process.stderr.write(`[comp-err] ${s}`);
  });

  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  try {
    process.stdout.write(`Waiting for competitor server to bind on port ${PORT}...\n`);
    const ready = await waitForServer(BASE_URL);
    if (!ready) {
      throw new Error(`Competitor server did not start on port ${PORT} within 20s.`);
    }
    process.stdout.write('Competitor server is ready.\n');

    // Add demo history
    process.stdout.write('Seeding competitor demo history via POST /api/demo...\n');
    try {
      await fetch(`${BASE_URL}/api/demo`, { method: 'POST', signal: AbortSignal.timeout(15_000) });
      process.stdout.write('Competitor demo history seeded.\n');
    } catch (e) {
      process.stdout.write(`Note on demo seed: ${e.message}\n`);
    }

    const promptResults = [];
    for (const item of PROMPTS) {
      process.stdout.write(`\nBenchmarking ${item.id} (${RUNS_PER_PROMPT} runs)...\n`);
      const runs = [];
      for (let i = 0; i < RUNS_PER_PROMPT; i += 1) {
        if (i > 0 || promptResults.length > 0) {
          process.stdout.write('Waiting 5s between runs...\n');
          await sleep(5000);
        }
        process.stdout.write(`  Run ${i + 1}/${RUNS_PER_PROMPT}: `);
        try {
          const result = await streamCompetitorChat(BASE_URL, item.prompt);
          const passed = item.check(result.answer);
          process.stdout.write(
            `status=${result.status_code}, TTFT=${result.first_token_ms}ms, `
            + `total=${result.total_ms}ms, check=${passed ? 'PASS' : 'FAIL'}\n`,
          );
          runs.push({ ...result, passed });
        } catch (err) {
          process.stdout.write(`ERROR: ${err.message}\n`);
          runs.push({
            status_code: 500,
            first_token_ms: null,
            total_ms: null,
            passed: false,
            error: err.message,
          });
        }
      }

      const validTokens = runs.map((r) => r.first_token_ms).filter((v) => v !== null);
      const validTotals = runs.map((r) => r.total_ms).filter((v) => v !== null);
      const passCount = runs.filter((r) => r.passed).length;

      promptResults.push({
        id: item.id,
        prompt: item.prompt,
        runs_count: RUNS_PER_PROMPT,
        pass_rate: Number((passCount / RUNS_PER_PROMPT).toFixed(2)),
        median_first_token_ms: median(validTokens),
        median_total_ms: median(validTotals),
        runs,
      });
    }

    const payload = {
      timestamp: new Date().toISOString(),
      benchmark: 'competitor_local_blackbox',
      competitors: [
        {
          repo: 'SanyamWadhwa07/minimi-chat-agent',
          status: 'measured',
          model_used: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
          search_provider: 'Tavily',
          runs_per_prompt: RUNS_PER_PROMPT,
          results: promptResults,
        },
        {
          repo: 'BhaveshKukreja29/minimi-hiring-challenge',
          status: 'skipped_missing_provider_key',
          reason: 'Hardcoded requirement for GROQ_API_KEY; does not support Gemini API key.',
        },
        {
          repo: 'Anu27n/minimi-chat-agent',
          status: 'skipped_missing_provider_key',
          reason: 'Hardcoded requirement for ANTHROPIC_API_KEY / OPENAI_API_KEY; does not support Gemini API key.',
        },
      ],
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nCompetitor benchmark results written to ${OUT_PATH}\n`);
  } finally {
    cleanup();
  }
}

runBenchmark().catch((err) => {
  process.stderr.write(`Benchmark fatal error: ${err.stack || err}\n`);
  process.exit(1);
});
