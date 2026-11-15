import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/memory/store.mjs';
import { runTurn } from '../src/agent/run-turn.mjs';
import { config } from '../src/config.mjs';
import { USER_STRINGS } from '../src/strings.mjs';
import { resolveDatePhrase } from '../src/time/resolve.mjs';

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

function containsFragmentOfLength(haystack, needle, minLength = 25) {
  const normHaystack = String(haystack || '').toLowerCase().replace(/\s+/g, ' ');
  const normNeedle = String(needle || '').toLowerCase().replace(/\s+/g, ' ');
  if (normNeedle.length < minLength) return normHaystack.includes(normNeedle);
  for (let i = 0; i <= normNeedle.length - minLength; i += 1) {
    const fragment = normNeedle.slice(i, i + minLength);
    if (normHaystack.includes(fragment)) return true;
  }
  return false;
}

export function deterministicChecks(run = {}, ctx = {}) {
  const promptId = ctx.promptId || run.id || (
    /CRM tools/i.test(run.prompt || '') ? 'official-1' :
    /3 November/i.test(run.prompt || '') ? 'official-2' :
    /Postgres hosting/i.test(run.prompt || '') ? 'official-3' : null
  );

  const rawAnswer = String(run.answer || '').trim();
  if (!rawAnswer) {
    return {
      passed: false,
      assertion: 'Produces a non-empty answer',
      reason: 'Empty answer received',
    };
  }
  const lowerAnswer = rawAnswer.toLowerCase();

  switch (promptId) {
    case 'official-1': {
      const flatCards = [];
      const entitySet = new Set();
      for (const item of (run.cards || [])) {
        if (item?.entity) entitySet.add(String(item.entity).toLowerCase());
        if (item?.entity_key) entitySet.add(String(item.entity_key).toLowerCase());
        if (Array.isArray(item?.cards)) {
          for (const card of item.cards) {
            if (card?.entity) entitySet.add(String(card.entity).toLowerCase());
            flatCards.push(card);
          }
        } else {
          flatCards.push(item);
        }
      }

      const requiredTools = ['hubspot', 'pipedrive', 'zoho', 'monday', 'freshsales'];
      const missingTools = requiredTools.filter((tool) => !Array.from(entitySet).some((e) => e.includes(tool)));
      if (missingTools.length > 0) {
        return {
          passed: false,
          assertion: 'A card exists for each of the 5 seeded CRM entities',
          reason: `Missing cards for: ${missingTools.join(', ')}`,
        };
      }

      for (const card of flatCards) {
        const isSame = card.status === USER_STRINGS.sameAsBefore || String(card.status || '').startsWith('Same as before');
        if (isSame) {
          const domain = card.domain
            || card.current?.domain
            || card.source_domain
            || (card.source_url ? (() => { try { return new URL(card.source_url).hostname; } catch { return null; } })() : null);
          if (!domain) {
            return {
              passed: false,
              assertion: 'No card has "Same as before" status without a current source domain',
              reason: `Card for ${card.entity || 'entity'} has Same as before status without a source domain`,
            };
          }
        }
      }

      return {
        passed: true,
        assertion: 'Covers all 5 CRM tools with cards and verified source domains for Same as before statuses',
        reason: `All 5 CRM tools covered with ${flatCards.length} cards`,
      };
    }

    case 'official-2': {
      const mentionsDate = lowerAnswer.includes('3 november')
        || lowerAnswer.includes('november 3')
        || lowerAnswer.includes('2026-11-03')
        || lowerAnswer.includes('03/11/2026');
      if (!mentionsDate) {
        return {
          passed: false,
          assertion: 'Answer contains the local date of the 3 November turn',
          reason: 'Missing 3 November date reference in answer',
        };
      }

      const seededQuestion = scenarios[1]?.earlierQuestion
        || 'How should I choose between two hosted PostgreSQL providers for a student side project?';
      const has25CharFragment = containsFragmentOfLength(rawAnswer, seededQuestion, 25);
      if (!has25CharFragment) {
        return {
          passed: false,
          assertion: 'Answer contains a fragment of at least 25 characters of the 3 Nov turn user_text',
          reason: 'Missing 25-character fragment of recalled question in answer',
        };
      }

      const statusPhrases = [
        USER_STRINGS.sameAsEarlierAnswer,
        USER_STRINGS.differsFromEarlierAnswer,
        USER_STRINGS.sameAsBefore,
        USER_STRINGS.changed,
        USER_STRINGS.changedNewerVersion,
        USER_STRINGS.couldntConfirm,
        USER_STRINGS.cannotCompareTerms,
        USER_STRINGS.noEarlierRecord,
      ].map((s) => s.toLowerCase());

      const statesStatus = statusPhrases.some((phrase) => lowerAnswer.includes(phrase))
        || /\b(same as (?:my )?earlier answer|differs from (?:my )?earlier answer|same as before|changed|couldn’t confirm|could not confirm)\b/i.test(lowerAnswer);

      if (!statesStatus) {
        return {
          passed: false,
          assertion: 'Answer states a current-status phrase from USER_STRINGS',
          reason: 'Missing current-status phrase from USER_STRINGS in answer',
        };
      }

      return {
        passed: true,
        assertion: 'References 3 Nov date, quotes at least 25 chars of user_text, and states status from USER_STRINGS',
        reason: 'Recalled 3 Nov question and evaluated current correctness',
      };
    }

    case 'official-3': {
      const tz = ctx.timezone || config.timezone || 'Asia/Kolkata';
      const clock = ctx.clock instanceof Date ? ctx.clock : (ctx.clock ? new Date(ctx.clock) : new Date());
      const promptPhrase = run.prompt || 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?';
      const expectedResolution = resolveDatePhrase(promptPhrase, tz, clock);
      const expectedDate = expectedResolution?.date;

      const actualDate = run.resolvedDate || run.resolved_date || run.recall?.resolved?.date || run.resolved?.date;
      if (actualDate && expectedDate && actualDate !== expectedDate) {
        return {
          passed: false,
          assertion: 'Resolved date equals what resolveDatePhrase returns for the run clock',
          reason: `Resolved date ${actualDate} does not match expected date ${expectedDate}`,
        };
      }
      if (!actualDate && expectedDate) {
        const hasDateInAnswer = lowerAnswer.includes(expectedDate)
          || lowerAnswer.includes(expectedDate.slice(5))
          || lowerAnswer.includes('10 november')
          || lowerAnswer.includes('november 10');
        if (!hasDateInAnswer) {
          return {
            passed: false,
            assertion: 'Resolved date equals what resolveDatePhrase returns for the run clock',
            reason: `Missing expected resolved date ${expectedDate} in run context or answer`,
          };
        }
      }

      const flatCards = [];
      const entitySet = new Set();
      for (const item of (run.cards || [])) {
        if (item?.entity) entitySet.add(String(item.entity).toLowerCase());
        if (item?.entity_key) entitySet.add(String(item.entity_key).toLowerCase());
        if (Array.isArray(item?.cards)) {
          for (const card of item.cards) {
            if (card?.entity) entitySet.add(String(card.entity).toLowerCase());
            flatCards.push(card);
          }
        } else {
          flatCards.push(item);
        }
      }

      const hasNeonCard = Array.from(entitySet).some((e) => e.includes('neon'))
        || flatCards.some((c) => String(c.entity || '').toLowerCase().includes('neon'));
      const hasSupabaseCard = Array.from(entitySet).some((e) => e.includes('supabase'))
        || flatCards.some((c) => String(c.entity || '').toLowerCase().includes('supabase'));

      if (!hasNeonCard || !hasSupabaseCard) {
        const missing = [!hasNeonCard && 'Neon', !hasSupabaseCard && 'Supabase'].filter(Boolean).join(', ');
        return {
          passed: false,
          assertion: 'Cards exist for Neon and Supabase',
          reason: `Missing cards for: ${missing}`,
        };
      }

      const mentionsNeon = lowerAnswer.includes('neon');
      const mentionsSupabase = lowerAnswer.includes('supabase');
      if (!mentionsNeon || !mentionsSupabase) {
        const missing = [!mentionsNeon && 'Neon', !mentionsSupabase && 'Supabase'].filter(Boolean).join(', ');
        return {
          passed: false,
          assertion: 'Answer names both Neon and Supabase',
          reason: `Missing in answer: ${missing}`,
        };
      }

      return {
        passed: true,
        assertion: 'Resolves last Tuesday, produces cards for Neon and Supabase, and names both in answer',
        reason: 'Postgres turn resolved and cards produced for Neon and Supabase',
      };
    }

    default:
      return {
        passed: true,
        assertion: 'Default check',
        reason: 'No deterministic check required for prompt',
      };
  }
}

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
