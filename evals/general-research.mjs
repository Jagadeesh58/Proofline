import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/memory/store.mjs';
import { runTurn } from '../src/agent/run-turn.mjs';
import { config } from '../src/config.mjs';
import { gradeGeneralResearch } from './grader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runGeneralResearchLive(limit = Infinity) {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is required.');
  if (config.searchBackend !== 'replay' && !config.tavilyKey) throw new Error('TAVILY_API_KEY is required.');
  if (!config.graderKey || !config.graderModel || !config.graderBaseUrl) throw new Error('The independent grader needs EVAL_GRADER_API_KEY, EVAL_GRADER_MODEL and EVAL_GRADER_BASE_URL.');
  const prompts = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/cases/general-research.json'), 'utf8')).prompts.slice(0, limit);
  const results = [];
  for (const prompt of prompts) {
    const store = new Store(':memory:');
    try {
      const output = await runTurn({ userText: prompt, timezone: config.timezone, store, send: () => {} });
      const stored = store.getTurn(output.turnId);
      const sources = store.getSources(output.turnId).map((source) => ({
        title: source.title, url: source.url, domain: source.registrable_domain,
        provider_date: source.provider_date, retrieval_kind: source.retrieval_kind,
        page_text: source.page_text?.slice(0, 5000) || null, snippet: source.snippet_text,
      }));
      const grade = await gradeGeneralResearch({ prompt, answer: stored?.assistant_text || output.text, sources });
      results.push({ prompt, answer: stored?.assistant_text || output.text, source_count: sources.length, grade, timings: output.timings, budgets: output.budgets });
    } finally { store.close(); }
  }
  return { cases_run: results.length, expected_cases: 15, grader_model: config.graderModel, results };
}
