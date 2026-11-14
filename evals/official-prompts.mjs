import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/memory/store.mjs';
import { runTurn } from '../src/agent/run-turn.mjs';
import { config } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarios = [
  {
    date: '2026-11-09',
    question: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    earlierQuestion: 'On Monday we shortlisted five CRM tools for a 20-person sales team. Which should we compare first?',
    earlierAnswer: 'The five tools shortlisted were HubSpot CRM Starter at $20 per user per month with no commitment, Pipedrive Essential at $15 per user per month with no commitment, Zoho CRM Standard at $14 per user per month with no commitment, Monday CRM Basic at $12 per user per month with no commitment, and Freshsales Growth at $9 per user per month with no commitment.',
  },
  {
    date: '2026-11-03',
    question: 'What did I ask you on 3 November? Is your answer still correct today?',
    earlierQuestion: 'How should I choose between two hosted PostgreSQL providers for a student side project?',
    earlierAnswer: 'I suggested comparing branching, connection pooling, backups, usage visibility, region availability and the provider documentation before selecting a host.',
  },
  {
    date: '2026-11-10',
    question: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    earlierQuestion: 'Which managed Postgres hosting options should I consider for a small backend project?',
    earlierAnswer: 'The options to evaluate were Neon, Supabase and AWS RDS. Compare the pricing model, storage, compute, backups and connection pooling before choosing.',
  },
];

function addHistory(store, scenario, mode) {
  if (mode === 'empty') return null;
  const displayAt = `${scenario.date}T10:00:00.000Z`;
  const sourceAt = mode === 'demo' ? '2026-10-20T10:00:00.000Z' : displayAt;
  if (mode === 'live') {
    const turn = store.createTurn({ userText: scenario.earlierQuestion, timezone: config.timezone, now: new Date(displayAt) });
    store.appendAssistantText(turn.id, scenario.earlierAnswer);
    store.updateTurn(turn.id, { status: 'completed', claims_status: 'pending' });
    return turn;
  }
  return store.importTurn({
    user_text: scenario.earlierQuestion,
    assistant_text: scenario.earlierAnswer,
    created_at: displayAt,
    source_created_at: sourceAt,
    timezone: config.timezone,
  }, config.timezone);
}

export async function runOfficialPromptsLive() {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is required for the official-prompt live evaluation.');
  if (config.searchBackend !== 'replay' && !config.tavilyKey) throw new Error('TAVILY_API_KEY is required, or set SEARCH_BACKEND=replay to use synthetic fixtures.');
  const prompts = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/cases/official-prompts.json'), 'utf8'));
  const results = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    for (const mode of prompts.history_modes) {
      const store = new Store(':memory:');
      const seeded = addHistory(store, scenario, mode);
      const events = { memory: [], statuses: [], errors: [], sources: [], cards: [], timings: null };
      try {
        const output = await runTurn({
          userText: scenario.question, timezone: config.timezone, store,
          send: (event, payload) => {
            if (event === 'memory') events.memory.push(...(payload.turns || []));
            if (event === 'status') events.statuses.push(payload.text);
            if (event === 'error') events.errors.push(payload);
            if (event === 'sources') events.sources = payload.sources || [];
            if (event === 'cards') events.cards = payload.cards || [];
            if (event === 'timings') events.timings = payload;
          },
        });
        const expectedRecall = mode !== 'empty';
        const recallExact = expectedRecall ? events.memory.some((turn) => turn.question === scenario.earlierQuestion) : events.memory.length === 0;
        results.push({
          scenario: scenarioIndex + 1, prompt: scenario.question, history_mode: mode,
          seeded_turn_id: seeded?.id || null,
          output: output.text,
          recall_exact: recallExact,
          memory_events: events.memory.length,
          source_count: events.sources.length,
          comparison_cards: events.cards.flatMap((entity) => entity.cards || []).map((card) => ({ entity: card.entity, status: card.status, reason: card.reason })),
          timings: output.timings,
          budgets: output.budgets,
          errors: events.errors,
        });
      } finally { store.close(); }
    }
  }
  return { cases_run: results.length, expected_cases: 12, recall_exact_passes: results.filter((item) => item.recall_exact).length, results };
}
