import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildId } from './build-id.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const HOSTED_URL = process.env.HOSTED_URL || 'https://proofline-znhc.onrender.com';
const SAMPLE_COUNT = Math.max(1, Number(process.env.COLD_SAMPLES || 5));
const OUT_DIR = path.join(ROOT, 'evals/results');

async function measureColdStart(baseUrl) {
  const start = Date.now();
  let firstStatusMs = null;
  let firstTokenMs = null;
  let totalMs = null;
  let error = null;

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'What did I ask you on 3 November? Is your answer still correct today?',
        timezone: 'UTC',
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.type === 'status' && firstStatusMs === null) {
            firstStatusMs = Date.now() - start;
          }
          if (payload.type === 'token' && firstTokenMs === null) {
            firstTokenMs = Date.now() - start;
          }
        } catch {}
      }
    }
    totalMs = Date.now() - start;
  } catch (err) {
    error = err.message || String(err);
    totalMs = Date.now() - start;
  }

  return { firstStatusMs, firstTokenMs, totalMs, error };
}

async function main() {
  const buildId = computeBuildId();
  process.stdout.write(`Measuring cold start latency against: ${HOSTED_URL} (build ${buildId})\n`);
  const samples = [];

  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    process.stdout.write(`Sample ${i + 1}/${SAMPLE_COUNT} running... `);
    const result = await measureColdStart(HOSTED_URL);
    samples.push(result);
    process.stdout.write(
      result.error
        ? `Failed: ${result.error}\n`
        : `Status: ${result.firstStatusMs}ms, Token: ${result.firstTokenMs}ms, Total: ${result.totalMs}ms\n`
    );
    if (i < SAMPLE_COUNT - 1 && process.env.COLD_SLEEP_SEC) {
      const sleepMs = Number(process.env.COLD_SLEEP_SEC) * 1000;
      await new Promise((res) => setTimeout(res, sleepMs));
    }
  }

  const output = {
    date: new Date().toISOString(),
    build_id: buildId,
    hosted_url: HOSTED_URL,
    samples,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `cold-${buildId}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  process.stdout.write(`Cold start evaluation results recorded to ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`Cold start evaluation failed: ${err.message}\n`);
  process.exit(1);
});
