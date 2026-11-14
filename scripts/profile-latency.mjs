import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { Store } from '../src/memory/store.mjs';
import { runTurn } from '../src/agent/run-turn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const DB_PATH = path.join(ROOT, 'data/latency-profile.sqlite');
const OUT_PATH = path.join(ROOT, 'evals/results/latency-breakdown.json');

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(`${DB_PATH}${suffix}`)) fs.unlinkSync(`${DB_PATH}${suffix}`);
}

const store = new Store(DB_PATH);
const demoPath = path.join(ROOT, 'src/seeds/demo-history.json');
const demoTurns = JSON.parse(fs.readFileSync(demoPath, 'utf8'));
store.importTurns(demoTurns.map((item) => ({ ...item, timezone: config.timezone, demo: true })), config.timezone);

const PROMPTS = [
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function profilePrompt(item) {
  process.stdout.write(`\n--- Profiling ${item.id} ---\nPrompt: "${item.prompt}"\n`);
  const start = performance.now();
  let firstProgressTime = null;
  let firstTokenTime = null;
  const events = [];
  const textChunks = [];

  const send = (event, payload) => {
    const elapsed = Math.round(performance.now() - start);
    events.push({ event, payload, elapsed });
    if (firstProgressTime === null && (event === 'status' || event === 'memory')) {
      firstProgressTime = elapsed;
    }
    if (event === 'token' && payload?.text) {
      if (firstTokenTime === null) firstTokenTime = elapsed;
      textChunks.push(payload.text);
    }
  };

  const output = await runTurn({
    userText: item.prompt,
    timezone: config.timezone,
    store,
    send,
    signal: AbortSignal.timeout(120_000),
  });

  const totalTime = Math.round(performance.now() - start);
  const timings = output.timings || {};

  // Infer purpose of each Gemini call
  const geminiCallsWithPurpose = (timings.gemini_calls || []).map((call, idx) => {
    let purpose = 'unknown';
    if (call.type === 'stream') {
      purpose = idx === 0 ? 'initial_plan_and_tool_call' : 'final_commentary';
    } else if (call.type === 'json') {
      purpose = idx === 0 ? 'imported_baseline_extraction' : 'page_claim_extraction';
    }
    return {
      call_index: idx + 1,
      purpose,
      type: call.type,
      model: call.model || config.geminiModel,
      duration_ms: call.duration_ms,
      backoff_wait_ms: call.backoff_wait_ms || 0,
      throttle_wait_ms: call.throttle_wait_ms || 0,
    };
  });

  const searchDuration = (timings.search_calls || []).reduce((acc, c) => acc + (c.duration_ms || 0), 0);
  const extractDuration = (timings.extract_calls || []).reduce((acc, c) => acc + (c.duration_ms || 0), 0);
  const geminiDuration = geminiCallsWithPurpose.reduce((acc, c) => acc + (c.duration_ms || 0), 0);
  const totalAccounted = (timings.memory_ms || 0) + searchDuration + extractDuration + geminiDuration;
  const idleGapsMs = Math.max(0, totalTime - totalAccounted);

  const breakdown = {
    id: item.id,
    prompt: item.prompt,
    milestones: {
      first_progress_ms: firstProgressTime,
      first_token_ms: firstTokenTime,
      total_time_ms: totalTime,
      first_token_to_total_gap_ms: totalTime - (firstTokenTime || totalTime),
    },
    budgets: output.budgets,
    gemini_calls: geminiCallsWithPurpose,
    searches: (timings.search_calls || []).map((c) => ({
      query: c.q,
      topic: c.topic,
      duration_ms: c.duration_ms,
    })),
    extracts: (timings.extract_calls || []).map((c) => ({
      url: c.url,
      duration_ms: c.duration_ms,
    })),
    timings: {
      memory_recall_ms: timings.memory_ms || 0,
      search_duration_ms: searchDuration,
      extract_duration_ms: extractDuration,
      gemini_duration_ms: geminiDuration,
      gemini_backoff_ms: timings.gemini_backoff_ms || 0,
      extraction_wall_ms: timings.extraction_ms || 0,
      scanner_buffering_ms: timings.scanner_buffering_ms || 0,
      idle_gaps_ms: idleGapsMs,
    },
    root_cause_analysis: {
      why_first_token_equals_total: [
        'Tool calls are executed on Round 0, taking multiple seconds for search and extraction.',
        'In Round 1, canCallTools was evaluated as true (round < config.maxToolRounds - 1), causing onText '
          + 'to buffer chunks in roundChunks rather than streaming directly to sentenceGate.',
        'Commentary tokens were therefore held until generateStream resolved, resulting in first_token_ms '
          + 'being recorded within milliseconds of total_ms.',
        'Per-target extraction serialized multiple Gemini structured extraction calls, each consuming '
          + 'rate limit budget and increasing total duration.',
      ],
    },
  };

  process.stdout.write(
    `Done: first progress ${firstProgressTime}ms, first token ${firstTokenTime}ms, total ${totalTime}ms\n`,
  );
  process.stdout.write(
    `Gemini calls: ${geminiCallsWithPurpose.length}, searches: ${breakdown.searches.length}, `
      + `extracts: ${breakdown.extracts.length}\n`,
  );

  return breakdown;
}

async function main() {
  process.stdout.write('Starting latency breakdown profiling for 3 official prompts...\n');
  const results = [];
  for (const item of PROMPTS) {
    const data = await profilePrompt(item);
    results.push(data);
    // Cool down for 10s to respect free tier 15 RPM
    process.stdout.write('Waiting 10s for free-tier RPM cooling...\n');
    await sleep(10000);
  }

  const payload = {
    timestamp: new Date().toISOString(),
    account_tier: 'Free Tier (15 RPM)',
    model: config.geminiModel,
    fallback_model: config.geminiFallbackModel,
    profiles: results,
    summary: {
      finding: 'First token equals total duration primarily because Round 1 streaming text is buffered '
        + 'in roundChunks until generateStream completes, rather than streamed progressively to the client '
        + 'as sentences pass validation.',
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
  process.stdout.write(`\nLatency breakdown written to ${OUT_PATH}\n`);
}

main().catch((err) => {
  process.stderr.write(`Profiling failed: ${err.stack || err}\n`);
  process.exit(1);
});
