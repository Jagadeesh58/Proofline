import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const targetUrl = process.env.HOSTED_URL || 'https://proofline-znhc.onrender.com';
const RUNS_PER_PROMPT = Math.max(1, Number(process.env.HOSTED_RUNS || (process.argv.includes('--quick') ? 1 : 5)));

const OFFICIAL_PROMPTS = [
  {
    id: 'official-1',
    prompt: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. '
      + 'Has any of them changed pricing or shipped something big since?',
  },
  {
    id: 'official-2',
    prompt: 'What did I ask you on 3 November? Is your answer still correct today?',
  },
  {
    id: 'official-3',
    prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
  },
];

function getGitInfo() {
  try {
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamChatSSE(url, message, cookie) {
  const start = performance.now();
  let firstStatusTime = null;
  let firstTokenTime = null;
  let answer = '';
  let hadError = false;
  let errorMessage = '';

  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  let currentEvent = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(jsonStr);
        const elapsed = Math.round(performance.now() - start);
        if (firstStatusTime === null && (currentEvent === 'status' || currentEvent === 'memory')) {
          firstStatusTime = elapsed;
        }
        if (currentEvent === 'token' && parsed.text && typeof parsed.text === 'string') {
          if (firstTokenTime === null) firstTokenTime = elapsed;
          answer += parsed.text;
        }
        if (currentEvent === 'error') {
          hadError = true;
          errorMessage = parsed.message || parsed.error || 'Unknown error event';
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  const totalTime = Math.round(performance.now() - start);
  if (hadError) throw new Error(`Stream error event: ${errorMessage}`);
  if (!answer.trim()) throw new Error('Empty answer received from stream');

  return {
    status_code: res.status,
    first_status_ms: firstStatusTime,
    first_token_ms: firstTokenTime,
    total_ms: totalTime,
    answer_length: answer.length,
    answer_preview: answer.slice(0, 150).replace(/[\r\n]+/g, ' '),
  };
}

async function checkHosted() {
  process.stdout.write(`Checking hosted deployment at: ${targetUrl}\n`);
  const gitInfo = getGitInfo();
  let cookie = null;

  try {
    // 1. Cold wake / Health probe
    const healthStart = performance.now();
    const healthRes = await fetch(`${targetUrl}/api/health`, { signal: AbortSignal.timeout(90_000) });
    const coldWakeMs = Math.round(performance.now() - healthStart);

    if (!healthRes.ok) {
      process.stderr.write(`FAIL: Health endpoint returned HTTP ${healthRes.status}\n`);
      process.exit(1);
    }
    const health = await healthRes.json();
    process.stdout.write(
      `Health OK: model=${health.model || 'unknown'}, search=${health.search_backend || 'unknown'}, `
      + `coldWake=${coldWakeMs}ms, uptime=${Math.round(health.uptime || 0)}s\n`
    );

    // 2. Session cookie initialization
    const sessionRes = await fetch(`${targetUrl}/`, { signal: AbortSignal.timeout(15_000) });
    const setCookie = sessionRes.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
      process.stdout.write(`Session cookie obtained: ${cookie.slice(0, 20)}...\n`);
    }

    // 3. Demo history check
    const demoRes = await fetch(`${targetUrl}/api/demo-history`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (demoRes.ok) {
      process.stdout.write('Demo history loaded successfully.\n');
    }

    // 4. Run each official prompt RUNS_PER_PROMPT times over SSE
    const delayMs = Number(process.env.HOSTED_DELAY_MS || 8000);
    const promptResults = [];
    for (const item of OFFICIAL_PROMPTS) {
      process.stdout.write(`\nTesting ${item.id} (${RUNS_PER_PROMPT} runs)...\n`);
      const runs = [];
      for (let i = 0; i < RUNS_PER_PROMPT; i += 1) {
        if (i > 0 || promptResults.length > 0) {
          process.stdout.write(`Waiting ${Math.round(delayMs / 1000)}s between requests...\n`);
          await sleep(delayMs);
        }
        process.stdout.write(`  Run ${i + 1}/${RUNS_PER_PROMPT}: `);
        try {
          const result = await streamChatSSE(targetUrl, item.prompt, cookie);
          process.stdout.write(
            `status=${result.status_code}, TTFT=${result.first_token_ms}ms, total=${result.total_ms}ms\n`
          );
          runs.push(result);
        } catch (err) {
          process.stdout.write(`FAILED: ${err.message}\n`);
          runs.push({
            status_code: 500,
            first_status_ms: null,
            first_token_ms: null,
            total_ms: null,
            error: err.message,
          });
        }
      }

      const firstStatuses = runs.map((r) => r.first_status_ms).filter((v) => v !== null);
      const firstTokens = runs.map((r) => r.first_token_ms).filter((v) => v !== null);
      const totals = runs.map((r) => r.total_ms);

      promptResults.push({
        id: item.id,
        prompt: item.prompt,
        runs_count: RUNS_PER_PROMPT,
        median: {
          first_status_ms: median(firstStatuses),
          first_token_ms: median(firstTokens),
          total_ms: median(totals),
        },
        runs,
      });
    }

    const timestamp = new Date().toISOString();
    const payload = {
      timestamp,
      target_url: targetUrl,
      commit: gitInfo.commit,
      clean_tree: !gitInfo.dirty,
      cold_wake_ms: coldWakeMs,
      server_health: health,
      prompts: promptResults,
    };

    const outDir = path.join(ROOT, 'evals/results');
    fs.mkdirSync(outDir, { recursive: true });
    const safeDate = timestamp.replace(/[:.]/g, '-');
    const outFile = path.join(outDir, `hosted-${safeDate}.json`);
    const latestFile = path.join(outDir, 'hosted-latest.json');

    fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.writeFileSync(latestFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nPASS: Hosted test recorded. Saved to ${outFile} and ${latestFile}\n`);
  } catch (err) {
    process.stderr.write(`\nFAIL: Hosted check failed: ${err.message}\n`);
    process.exit(1);
  }
}

checkHosted();
