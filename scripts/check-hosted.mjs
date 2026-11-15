import http from 'node:http';

const targetUrl = process.env.HOSTED_URL || 'https://proofline-znhc.onrender.com';

async function checkHosted() {
  process.stdout.write(`Checking hosted deployment at: ${targetUrl}\n`);
  try {
    const healthRes = await fetch(`${targetUrl}/api/health`, { signal: AbortSignal.timeout(15_000) });
    if (!healthRes.ok) {
      process.stderr.write(`FAIL: Health endpoint returned HTTP ${healthRes.status}\n`);
      process.exit(1);
    }
    const health = await healthRes.json();
    if (!health.ok && health.status !== 'ok') {
      process.stderr.write(`FAIL: Health payload status is not ok: ${JSON.stringify(health)}\n`);
      process.exit(1);
    }

    process.stdout.write(
      `Health OK: model=${health.model || 'unknown'}, search=${health.search_backend || 'unknown'}, `
      + `uptime=${Math.round(health.uptime || 0)}s\n`
    );

    // Warm chat probe
    const chatRes = await fetch(`${targetUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is 2 + 2?' }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!chatRes.ok) {
      process.stderr.write(`FAIL: Chat endpoint returned HTTP ${chatRes.status}\n`);
      process.exit(1);
    }

    const text = await chatRes.text();
    const hasData = text.includes('data:');
    if (!hasData) {
      process.stderr.write('FAIL: Chat endpoint returned non-SSE response\n');
      process.exit(1);
    }

    process.stdout.write('Chat SSE stream response received successfully.\n');
    process.stdout.write(`PASS: Hosted deployment at ${targetUrl} is healthy and responding.\n`);
  } catch (err) {
    process.stderr.write(`FAIL: Could not reach hosted instance: ${err.message}\n`);
    process.exit(1);
  }
}

checkHosted();
