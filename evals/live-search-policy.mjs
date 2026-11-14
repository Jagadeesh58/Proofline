import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { SYSTEM_PROMPT } from '../src/agent/prompts.mjs';
import { generateStream, webSearchDeclaration } from '../src/llm/gemini.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runSearchPolicyLive(limit = Infinity) {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is required for the live search-policy evaluation.');
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/cases/search-policy.json'), 'utf8'));
  const cases = source.cases.slice(0, limit);
  const results = [];
  for (const item of cases) {
    const started = Date.now();
    try {
      const response = await generateStream({
        contents: [{ role: 'user', parts: [{ text: item.prompt }] }],
        systemInstruction: SYSTEM_PROMPT,
        toolDeclaration: webSearchDeclaration,
      });
      const searched = response.functionCalls.some((call) => call.name === 'web_search');
      results.push({ id: item.id, expected_search: item.expected_search, actual_search: searched, pass: searched === item.expected_search, latency_ms: Date.now() - started });
    } catch (error) {
      results.push({ id: item.id, expected_search: item.expected_search, actual_search: null, pass: false, error: error.code || 'provider_error' });
    }
  }
  return {
    run_id: `search-policy-${randomUUID().slice(0, 8)}`,
    model: config.geminiModel,
    date: new Date().toISOString(),
    cases_run: results.length,
    pass: results.filter((item) => item.pass).length,
    fail: results.filter((item) => !item.pass).length,
    stale_trap_recall: results.filter((item) => item.expected_search && item.pass).length,
    stable_control_specificity: results.filter((item) => !item.expected_search && item.pass).length,
    results,
  };
}
