import { splitSentences } from '../evidence/answer-stream.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isReplayModelActive(settings) {
  return Boolean(settings.demoMode);
}

export function formatTurnDate(dateStr) {
  if (!dateStr) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  if (!match) return String(dateStr);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const day = parseInt(match[3], 10);
  const monthName = months[parseInt(match[2], 10) - 1];
  const year = match[1];
  return `${day} ${monthName} ${year}`;
}

export function matchOfficialPrompt(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (norm.includes('crm tools') && norm.includes('20 person') && norm.includes('shortlist')) {
    return 1;
  }
  if (norm.includes('3 november') || (norm.includes('november 3') && norm.includes('ask'))) {
    return 2;
  }
  if (norm.includes('last tuesday') && (norm.includes('postgres') || norm.includes('hosting'))) {
    return 3;
  }
  return 0;
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
        evidence_quote: 'HubSpot announced a new shared inbox feature in this update.',
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
  recall,
  onText,
  onTiming,
}) {
  const started = Date.now();
  const userTurn = contents.find((c) => c.role === 'user' && c.parts?.some((p) => typeof p.text === 'string'));
  const userText = userTurn?.parts?.map((p) => p.text).filter(Boolean).join(' ') || '';
  const lastUserTurn = [...contents].reverse().find((c) => c.role === 'user');
  const hasToolResponse = lastUserTurn?.parts?.some((p) => p.functionResponse);

  const promptId = matchOfficialPrompt(userText);

  // The offline demo only answers the three official challenge prompts
  if (promptId === 0) {
    if (toolDeclaration && !hasToolResponse) {
      onTiming?.({
        type: 'stream',
        model: 'offline-demo',
        duration_ms: Date.now() - started,
        functionCallsCount: 0,
      });
      return {
        text: '',
        functionCalls: [],
        modelParts: [],
        effectiveModel: 'offline-demo',
      };
    }

    const unsupportedText =
      'The offline demo only knows the three official prompts. '
      + 'Add GEMINI_API_KEY and TAVILY_API_KEY to try anything else.';
    if (!signal?.aborted) {
      onText?.(unsupportedText);
    }
    onTiming?.({
      type: 'stream',
      model: 'offline-demo',
      duration_ms: Date.now() - started,
      functionCallsCount: 0,
    });
    return {
      text: unsupportedText,
      functionCalls: [],
      modelParts: [{ text: unsupportedText }],
      effectiveModel: 'offline-demo',
    };
  }

  // Round 0: if tool declaration is present and no tool response yet, generate tool call
  if (toolDeclaration && !hasToolResponse) {
    let targets = [];
    if (promptId === 1) {
      targets = [
        { entity: 'HubSpot', checks: ['pricing', 'news'] },
        { entity: 'Pipedrive', checks: ['pricing', 'news'] },
        { entity: 'Zoho CRM', checks: ['pricing', 'news'] },
        { entity: 'Monday CRM', checks: ['pricing', 'news'] },
        { entity: 'Freshsales', checks: ['pricing', 'news'] },
      ];
    } else if (promptId === 2 || promptId === 3) {
      targets = [
        { entity: 'Neon', checks: ['pricing', 'news'] },
        { entity: 'Supabase', checks: ['pricing', 'news'] },
      ];
    }

    const functionCall = {
      name: 'web_search',
      args: { queries: [], targets },
    };

    onTiming?.({
      type: 'stream',
      model: 'offline-demo',
      duration_ms: Date.now() - started,
      functionCallsCount: 1,
    });

    return {
      text: '',
      functionCalls: [functionCall],
      modelParts: [{ functionCall }],
      effectiveModel: 'offline-demo',
    };
  }

  // Round 1: build the first sentence from the recalled turns the date resolver returned
  let firstSentence = '';
  const matchingTurn = recall?.recalled?.[0];
  if (matchingTurn) {
    const rawDate = matchingTurn.local_date
      || (matchingTurn.created_at_utc ? matchingTurn.created_at_utc.slice(0, 10) : null)
      || recall?.resolved?.date;
    const turnDate = formatTurnDate(rawDate) || 'earlier';
    const qText = matchingTurn.user_text || matchingTurn.question || '';
    firstSentence = `On ${turnDate}, you asked: "${qText}". `;
  } else {
    const rawDate = recall?.resolved?.date;
    const queryDate = formatTurnDate(rawDate) || 'the requested date';
    firstSentence = `No earlier conversation was found for ${queryDate}. `;
  }

  let continuation = '';
  if (promptId === 1) {
    continuation =
      'Checking official sources [S1] shows that HubSpot CRM Starter is listed at $20 per user per month '
      + 'with monthly billing and no annual commitment, representing a change in billing terms from the '
      + 'annual baseline. Pipedrive Essential remains at $15 per user per month [S2], and Zoho CRM '
      + 'Standard remains at $14 per user per month [S3]. HubSpot also announced a new shared inbox feature '
      + 'in its latest changelog [S4]. Monday CRM and Freshsales could not be confirmed because no fresh '
      + 'official pages were retrieved in this search.';
  } else if (promptId === 2) {
    continuation =
      'Checking official sources confirms that Neon Launch remains listed at $19 per month on usage billing [S1], '
      + 'and Supabase Pro remains at $25 per month flat fee [S2]. The pricing and architecture trade-offs '
      + 'from your earlier answer remain accurate today.';
  } else if (promptId === 3) {
    if (matchingTurn) {
      continuation =
        'Official pricing pages show that Neon Launch remains at $19 per month on usage billing [S1], '
        + 'and Supabase Pro remains at $25 per month flat fee [S2]. No pricing changes have been detected '
        + 'for either provider since last Tuesday.';
    } else {
      continuation =
        'The fixture page lists Neon Launch at $19 per month on usage billing [S1], '
        + 'and Supabase Pro at $25 per month flat fee [S2].';
    }
  }

  const answerText = firstSentence + continuation;

  // Stream text progressively
  const sentences = splitSentences(answerText);
  for (const sentence of sentences) {
    if (signal?.aborted) break;
    onText?.(sentence + ' ');
    await sleep(20);
  }

  onTiming?.({
    type: 'stream',
    model: 'offline-demo',
    duration_ms: Date.now() - started,
    functionCallsCount: 0,
  });

  return {
    text: answerText,
    functionCalls: [],
    modelParts: [{ text: answerText }],
    effectiveModel: 'offline-demo',
  };
}
