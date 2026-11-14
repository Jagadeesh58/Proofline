import { splitSentences } from '../evidence/answer-stream.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isReplayModelActive(settings) {
  return Boolean(settings.demoMode);
}

export function replayJsonExtraction(prompt) {
  const claims = [];
  const sourceBlocks = prompt.split('SOURCE_ID: ').slice(1);

  for (const block of sourceBlocks) {
    const lines = block.split('\n');
    const sourceId = lines[0].trim();
    const startIdx = block.indexOf('UNTRUSTED_EVIDENCE_BEGIN') + 24;
    const endIdx = block.indexOf('UNTRUSTED_EVIDENCE_END');
    const evidenceText = block.slice(startIdx, endIdx);

    if (evidenceText.includes('HubSpot CRM Starter costs $20')) {
      claims.push({
        source_id: sourceId,
        entity: 'HubSpot',
        attribute: 'price',
        plan_name: 'Starter',
        value_text: '$20 per user per month',
        amount: 20,
        currency: 'USD',
        price_unit: 'per_seat',
        period: 'month',
        commitment: 'none',
        evidence_quote:
          'HubSpot CRM Starter costs $20 per user per month with monthly billing and no annual commitment.',
      });
    }
    if (evidenceText.includes('HubSpot announced a new shared inbox feature')) {
      claims.push({
        source_id: sourceId,
        entity: 'HubSpot',
        attribute: 'release',
        value_text: 'shared inbox feature',
        evidence_quote: 'HubSpot announced a new shared inbox feature in this fictional evaluation update.',
      });
    }
    if (evidenceText.includes('Pipedrive CRM Essential costs $15')) {
      claims.push({
        source_id: sourceId,
        entity: 'Pipedrive',
        attribute: 'price',
        plan_name: 'Essential',
        value_text: '$15 per user per month',
        amount: 15,
        currency: 'USD',
        price_unit: 'per_seat',
        period: 'month',
        commitment: 'none',
        evidence_quote: 'Pipedrive CRM Essential costs $15 per user per month, billed monthly with no commitment.',
      });
    }
    if (evidenceText.includes('Neon Launch costs $19 per month')) {
      claims.push({
        source_id: sourceId,
        entity: 'Neon',
        attribute: 'price',
        plan_name: 'Launch',
        value_text: '$19 per month',
        amount: 19,
        currency: 'USD',
        price_unit: 'usage',
        period: 'month',
        commitment: 'none',
        evidence_quote: 'Neon Launch costs $19 per month on usage billing.',
      });
    }
    if (evidenceText.includes('Supabase Pro costs $25 per month')) {
      claims.push({
        source_id: sourceId,
        entity: 'Supabase',
        attribute: 'price',
        plan_name: 'Pro',
        value_text: '$25 per month',
        amount: 25,
        currency: 'USD',
        price_unit: 'flat',
        period: 'month',
        commitment: 'monthly',
        evidence_quote: 'Supabase Pro costs $25 per month with a monthly commitment.',
      });
    }
    if (evidenceText.includes('Zoho CRM Standard costs $14')) {
      claims.push({
        source_id: sourceId,
        entity: 'Zoho CRM',
        attribute: 'price',
        plan_name: 'Standard',
        value_text: '$14 per user per month',
        amount: 14,
        currency: 'USD',
        price_unit: 'per_seat',
        period: 'month',
        commitment: 'none',
        evidence_quote: 'Zoho CRM Standard costs $14 per user per month.',
      });
    }
    if (evidenceText.includes('GitHub Team costs $4')) {
      claims.push({
        source_id: sourceId,
        entity: 'GitHub',
        attribute: 'price',
        plan_name: 'Team',
        value_text: '$4 per user per month',
        amount: 4,
        currency: 'USD',
        price_unit: 'per_seat',
        period: 'month',
        commitment: 'none',
        evidence_quote: 'GitHub Team costs $4 per user per month with monthly billing.',
      });
    }
    if (evidenceText.includes('PostgreSQL stable release version 18.2')) {
      claims.push({
        source_id: sourceId,
        entity: 'PostgreSQL',
        attribute: 'version',
        value_text: '18.2',
        evidence_quote: 'PostgreSQL stable release version 18.2 is used only as a comparison test value.',
      });
    }
  }

  return { claims };
}

export async function replayStreamExecution({
  contents,
  toolDeclaration,
  signal,
  onText,
  onTiming,
}) {
  const started = Date.now();
  const userTurn = contents.find((c) => c.role === 'user' && c.parts?.some((p) => typeof p.text === 'string'));
  const userText = userTurn?.parts?.map((p) => p.text).filter(Boolean).join(' ') || '';
  const lastUserTurn = [...contents].reverse().find((c) => c.role === 'user');
  const hasToolResponse = lastUserTurn?.parts?.some((p) => p.functionResponse);

  // Round 0: if tool declaration is present and no tool response yet, generate tool call
  if (toolDeclaration && !hasToolResponse) {
    let targets = [];
    const textLower = userText.toLowerCase();

    if (textLower.includes('crm') || textLower.includes('shortlist') || textLower.includes('sales team')) {
      targets = [
        { entity: 'HubSpot', checks: ['pricing', 'news'] },
        { entity: 'Pipedrive', checks: ['pricing', 'news'] },
        { entity: 'Zoho CRM', checks: ['pricing', 'news'] },
        { entity: 'Monday CRM', checks: ['pricing', 'news'] },
        { entity: 'Freshsales', checks: ['pricing', 'news'] },
      ];
    } else if (textLower.includes('postgres') || textLower.includes('neon') || textLower.includes('supabase')) {
      targets = [
        { entity: 'Neon', checks: ['pricing', 'news'] },
        { entity: 'Supabase', checks: ['pricing', 'news'] },
      ];
    } else if (textLower.includes('3 november') || textLower.includes('november 3')) {
      targets = [
        { entity: 'Neon', checks: ['pricing'] },
        { entity: 'Supabase', checks: ['pricing'] },
      ];
    } else {
      targets = [{ entity: userText.slice(0, 50).trim(), checks: ['pricing'] }];
    }

    const functionCall = {
      name: 'web_search',
      args: { queries: [], targets },
    };

    onTiming?.({
      type: 'stream',
      model: 'replay-deterministic',
      duration_ms: Date.now() - started,
      functionCallsCount: 1,
    });

    return {
      text: '',
      functionCalls: [functionCall],
      modelParts: [{ functionCall }],
      effectiveModel: 'replay-deterministic',
    };
  }

  // Round 1 commentary or direct response
  let answerText = '';
  const textLower = userText.toLowerCase();
  const hasCRM = textLower.includes('crm') || textLower.includes('shortlist') || textLower.includes('sales team');
  const hasNov3 = textLower.includes('3 november') || textLower.includes('november 3');
  const hasPostgres = textLower.includes('postgres') || textLower.includes('hosting');

  if (hasCRM) {
    answerText =
      'On Monday, 9 November 2026, we shortlisted HubSpot, Pipedrive, Zoho CRM, Monday CRM, and Freshsales '
      + 'for a 20-person sales team. Checking official sources [S1] shows that HubSpot CRM Starter is listed '
      + 'at $20 per user per month with monthly billing and no annual commitment, representing a change in '
      + 'billing terms from the annual baseline. Pipedrive Essential remains at $15 per user per month [S2], '
      + 'and Zoho CRM Standard remains at $14 per user per month [S3]. HubSpot also announced a new shared '
      + 'inbox feature in its latest changelog [S4]. Monday CRM and Freshsales could not be confirmed '
      + 'because no fresh official pages were retrieved in this search.';
  } else if (hasNov3) {
    answerText =
      'On 3 November 2026, you asked: "How should I choose between managed PostgreSQL providers for a '
      + 'small backend project?". Checking official sources confirms that Neon Launch remains listed at '
      + '$19 per month on usage billing [S1], and Supabase Pro remains at $25 per month flat fee [S2]. '
      + 'The pricing and architecture trade-offs from your earlier answer remain accurate today.';
  } else if (hasPostgres) {
    answerText =
      'Last Tuesday, 10 November 2026, you asked about managed Postgres hosting options. '
      + 'Official pricing pages show that Neon Launch remains at $19 per month on usage billing [S1], '
      + 'and Supabase Pro remains at $25 per month flat fee [S2]. '
      + 'No pricing changes have been detected for either provider since last Tuesday.';
  } else if (textLower.includes('database index') || textLower.includes('b-tree')) {
    answerText =
      'A database index is a data structure that improves data retrieval speed at the cost of additional '
      + 'storage and write overhead. A B-tree index maintains sorted keys in balanced nodes, making it '
      + 'ideal for equality lookups, range scans, and prefix matches.';
  } else if (textLower.includes('20 seats') || textLower.includes('billed annually')) {
    answerText =
      'For 20 seats at $15 per user per month billed annually, the total cost is '
      + '20 × $15 × 12 = $3,600 per year.';
  } else {
    answerText =
      'In replay mode, queries are matched against the committed offline fixture corpus. '
      + 'The requested information was evaluated using stored search and extraction records.';
  }

  // Stream text progressively
  const sentences = splitSentences(answerText);
  for (const sentence of sentences) {
    if (signal?.aborted) break;
    onText?.(sentence + ' ');
    await sleep(20);
  }

  onTiming?.({
    type: 'stream',
    model: 'replay-deterministic',
    duration_ms: Date.now() - started,
    functionCallsCount: 0,
  });

  return {
    text: answerText,
    functionCalls: [],
    modelParts: [{ text: answerText }],
    effectiveModel: 'replay-deterministic',
  };
}
