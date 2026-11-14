import { randomUUID } from 'node:crypto';
import { generateJson } from '../llm/gemini.mjs';
import { CLAIM_EXTRACTION_PROMPT } from '../agent/prompts.mjs';
import { excerptWindow } from '../search/excerpts.mjs';
import { config } from '../config.mjs';
import { entityMatchCandidates, normaliseEntity } from '../seeds/domains.mjs';
import DEFAULT_PLANS from '../seeds/plans.json' with { type: 'json' };
import { splitSentences } from './answer-stream.mjs';

export const CLAIM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    claims: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          source_id: { type: 'STRING' },
          entity: { type: 'STRING' },
          attribute: { type: 'STRING', enum: ['price', 'limit', 'version', 'release'] },
          plan_name: { type: 'STRING' },
          value_text: { type: 'STRING' },
          amount: { type: 'NUMBER' },
          currency: { type: 'STRING' },
          price_unit: { type: 'STRING', enum: ['per_seat', 'flat', 'usage', 'none', 'unknown'] },
          unit: { type: 'STRING' },
          period: { type: 'STRING' },
          commitment: { type: 'STRING' },
          qualifiers: { type: 'ARRAY', items: { type: 'STRING' } },
          evidence_quote: { type: 'STRING' },
        },
        required: ['source_id', 'entity', 'attribute', 'value_text', 'evidence_quote'],
      },
    },
  },
  required: ['claims'],
};

export function normaliseEvidenceText(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'")
    .replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function findVerbatimSlice(pageText, candidateQuote) {
  if (!pageText || !candidateQuote) return null;
  const rawText = String(pageText);
  const rawQuote = String(candidateQuote).trim();
  if (!rawQuote) return null;

  if (rawText.includes(rawQuote)) {
    return rawQuote;
  }

  const lowerText = rawText.toLowerCase();
  const lowerQuote = rawQuote.toLowerCase();
  const directIdx = lowerText.indexOf(lowerQuote);
  if (directIdx !== -1) {
    return rawText.slice(directIdx, directIdx + rawQuote.length);
  }

  const words = rawQuote.match(/[^\s]+/g);
  if (words && words.length > 0) {
    const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    try {
      const regex = new RegExp(pattern, 'i');
      const match = rawText.match(regex);
      if (match && match[0]) {
        return match[0];
      }
    } catch {
      // Ignore regex syntax errors.
    }
  }

  const strippedWords = rawQuote.replace(/["'“”‘’]/g, '').match(/[A-Za-z0-9$€£₹.%+-]+/g);
  if (strippedWords && strippedWords.length >= 3) {
    const tokenPattern = strippedWords
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^A-Za-z0-9$€£₹.%+-]+');
    try {
      const tokenRegex = new RegExp(tokenPattern, 'i');
      const tokenMatch = rawText.match(tokenRegex);
      if (tokenMatch && tokenMatch[0]) {
        return tokenMatch[0];
      }
    } catch {
      // Ignore pattern syntax errors.
    }
  }

  return null;
}

function numberToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function quoteContainsAmount(quote, amount) {
  if (amount === null || amount === undefined) return true;
  const value = numberToken(amount);
  if (value === null) return false;
  const normal = String(quote).replace(/,/g, '');
  const tokens = [...normal.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  return tokens.some((token) => Math.abs(token - value) < 0.000001);
}

function canonicalValueText(value) {
  return normaliseEvidenceText(value).replace(/\s*\/\s*/g, ' per ')
    .replace(/\bmo\b/g, 'month').replace(/\s+/g, ' ').trim();
}

function quoteSupportsValueText(quote, valueText) {
  const quoted = canonicalValueText(quote);
  const value = canonicalValueText(valueText);
  return Boolean(value) && quoted.includes(value);
}

function canonicalPriceUnit(_value, quote) {
  const lower = String(quote || '').toLowerCase();
  const perSeatRegex = new RegExp(
    'per\\s+(user|seat|member|agent|host)|each\\s+(user|seat|member|agent|host)|\\/\\s*(user|seat|member|agent|host)'
  );
  if (perSeatRegex.test(lower)) return 'per_seat';
  const usageRegex = new RegExp(
    'usage[- ]based|based on usage|on usage billing|usage billing|'
    + 'per (?:api call|request|gb|gb-hour|hour)|pay as you go'
  );
  if (usageRegex.test(lower)) return 'usage';
  if (/flat fee|per workspace|per account|per organisation|per organization|per company/.test(lower)) return 'flat';
  if (/no per[- ]seat fee|not charged per user/.test(lower)) return 'none';
  return 'unknown';
}

export function currencyFromQuote(value, quote, pageText = '') {
  const combinedQuote = String(quote || '').trim();
  if (!combinedQuote) return null;

  // 1. Explicit prefixed dollar signs
  if (/(?:^|[^a-z])(?:us|usd)\$\s?\d/i.test(combinedQuote)) return 'USD';
  if (/(?:^|[^a-z])(?:ca|cad|c)\$\s?\d/i.test(combinedQuote)) return 'CAD';
  if (/(?:^|[^a-z])(?:au|aud|a)\$\s?\d/i.test(combinedQuote)) return 'AUD';
  if (/(?:^|[^a-z])(?:sg|sgd|s)\$\s?\d/i.test(combinedQuote)) return 'SGD';
  if (/(?:^|[^a-z])(?:nz|nzd)\$\s?\d/i.test(combinedQuote)) return 'NZD';
  if (/(?:^|[^a-z])(?:hk|hkd)\$\s?\d/i.test(combinedQuote)) return 'HKD';

  // 2. Explicit ISO currency codes and spelled-out currency names in quote
  if (/\b(?:usd|us dollars?)\b/i.test(combinedQuote)) return 'USD';
  if (/\b(?:cad|canadian dollars?)\b/i.test(combinedQuote)) return 'CAD';
  if (/\b(?:aud|australian dollars?)\b/i.test(combinedQuote)) return 'AUD';
  if (/\b(?:sgd|singapore dollars?)\b/i.test(combinedQuote)) return 'SGD';
  if (/\b(?:eur|euros?)\b/i.test(combinedQuote)) return 'EUR';
  if (/\b(?:gbp|pounds?(?: sterling)?)\b/i.test(combinedQuote)) return 'GBP';
  if (/\b(?:inr|indian rupees?|rupees?|rs\.?)\b/i.test(combinedQuote)) return 'INR';
  if (/\b(?:jpy|yen)\b/i.test(combinedQuote)) return 'JPY';

  // 3. Unambiguous symbols in quote
  if (combinedQuote.includes('€')) return 'EUR';
  if (combinedQuote.includes('£')) return 'GBP';
  if (combinedQuote.includes('₹')) return 'INR';
  if (combinedQuote.includes('¥')) return 'JPY';

  // 4. Bare dollar sign ($) in quote
  if (combinedQuote.includes('$')) {
    const val = String(value || '').toUpperCase();
    if (['USD', 'CAD', 'AUD', 'SGD', 'NZD', 'HKD'].includes(val)) return val;
    if (pageText) {
      if (/\b(?:cad|canadian dollars?)\b/i.test(pageText)) return 'CAD';
      if (/\b(?:aud|australian dollars?)\b/i.test(pageText)) return 'AUD';
      if (/\b(?:sgd|singapore dollars?)\b/i.test(pageText)) return 'SGD';
      if (/\b(?:usd|us dollars?)\b/i.test(pageText)) return 'USD';
    }
    return 'ambiguous_dollar';
  }

  // Quote has no currency symbol or code; do not infer currency.
  return null;
}

function periodFromQuote(value, quote) {
  const source = String(quote || '').toLowerCase();
  const monthRegex = /\b(?:per|\/|each)\s*(?:month|mo|monthly)\b|\bmonthly\b|\bper month\b|\/mo\b|month[- ]to[- ]month/;
  if (monthRegex.test(source)) return 'month';
  const yearRegex = new RegExp(
    '\\b(?:per|\\/|each)\\s*(?:year|yr|annual|annually|yearly)\\b|\\b(?:annual(?:ly)?|yearly)\\b|'
    + '\\bper year\\b|\\/(?:yr|year)\\b'
  );
  if (yearRegex.test(source)) return 'year';
  if (/\b(?:per|\/|each)\s*(?:week|weekly)\b|\bweekly\b/.test(source)) return 'week';
  if (/\b(?:per|\/|each)\s*(?:day|daily)\b|\bdaily\b/.test(source)) return 'day';
  return 'unknown';
}

function quoteContext(pageText, quote, radius = 200) {
  const text = String(pageText || '');
  const escaped = String(quote || '').trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  if (!escaped) return String(quote || '');
  const match = new RegExp(escaped, 'i').exec(text);
  if (!match) return String(quote || '');
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return text.slice(start, end);
}

export function commitmentFromQuote(value, quote, pageText = '', planName = '') {
  const quoteLower = String(quote || '').toLowerCase();

  function detectCommitment(text) {
    if (/no commitment|no contract|cancel any time|cancel anytime|one[- ]time payment/.test(text)) return 'none';
    const annualRegex = new RegExp(
      'billed annually|billed yearly|annual billing|paid annually|annual commitment|'
      + 'yearly commitment|12[- ]month contract|annual contract|monthly equivalent|billed every year'
    );
    if (annualRegex.test(text)) return 'annual';
    const monthlyRegex = new RegExp(
      'billed monthly|monthly billing|month[- ]to[- ]month|monthly commitment|'
      + 'month[- ]long contract|billed every month'
    );
    if (monthlyRegex.test(text)) return 'monthly';
    if (/usage[- ]based|pay as you go|based on usage/.test(text)) return 'usage';
    return null;
  }

  // 1. Direct quote check
  const direct = detectCommitment(quoteLower);
  if (direct) return direct;

  // 2. Check nearby context in pageText, avoiding sentences for other plans
  if (pageText) {
    const context = quoteContext(pageText, quote, 200);
    const otherPlanPattern = new RegExp(
      '\\b(?:professional|pro|enterprise|team|plus|premium|growth|business|starter|basic|standard|ultimate)\\b',
      'gi'
    );
    const targetPlan = String(planName || '').toLowerCase().trim();
    const sentences = splitSentences(context);

    for (const sentence of sentences) {
      const sLower = sentence.toLowerCase();
      const term = detectCommitment(sLower);
      if (term) {
        const planMentions = [...sLower.matchAll(otherPlanPattern)].map((m) => m[0].toLowerCase());
        const mentionsOther = planMentions.some((m) => targetPlan && !targetPlan.includes(m));
        if (!mentionsOther) {
          return term;
        }
      }
    }
  }

  return 'unknown';
}

function supportedUnit(value, quote) {
  const unit = String(value || '').toLowerCase().trim();
  if (!unit) return null;
  const source = String(quote || '').toLowerCase();
  const canonical = unit.replace(/s$/, '');
  return source.includes(unit) || source.includes(canonical) ? unit : null;
}

function supportedPlan(value, quote, entityKey, plans = {}) {
  const plan = planKey(value);
  if (plan === 'unspecified') return plan;
  const source = normaliseEvidenceText(quote);
  const aliasMap = plans[entityKey]?.plan_aliases || {};
  const aliases = Object.keys(aliasMap).map((k) => planKey(k));
  const planMatches = source.includes(plan) || aliases.some((candidate) => source.includes(candidate));
  if (!planMatches) return 'unspecified';
  return planKey(aliasMap[planKey(plan)] || plan);
}

function explicitQualifiers(values, quote) {
  const source = String(quote).toLowerCase();
  const allowed = [];
  for (const item of Array.isArray(values) ? values : []) {
    const value = String(item).toLowerCase().trim();
    if (value === 'promo' && /promo|promotion|discount|introductory|special offer/.test(source)) {
      allowed.push('promo');
    } else if (value === 'excl_tax' && /excluding tax|excl(?:uding)?\.?\s+(?:gst|vat|tax)/.test(source)) {
      allowed.push('excl_tax');
    } else if (/^min_seats:\d+$/.test(value)) {
      const seatsCount = value.split(':')[1];
      const minRegex = new RegExp(
        `minimum\\s+of\\s+${seatsCount.toUpperCase()}\\s+(?:seats|users)|`
        + `min(?:imum)?\\s+${seatsCount}\\s+(?:seats|users)`
      );
      if (minRegex.test(source)) allowed.push(value);
    } else if (/^market:[a-z]{2}$/.test(value)) {
      const marketCode = value.split(':')[1];
      const marketRegex = new RegExp(`\\b(?:${marketCode}\\s+market|market\\s*[:=]?\\s*${marketCode})\\b`, 'i');
      if (marketRegex.test(source)) allowed.push(`market:${marketCode.toUpperCase()}`);
    } else if (/^channel:(stable|beta|lts)$/.test(value)) {
      const channelName = value.split(':')[1];
      const channelRegex = new RegExp(`\\b${channelName}\\b`, 'i');
      if (channelRegex.test(source)) allowed.push(value);
    }
  }
  return [...new Set(allowed)].sort();
}

function entityKey(value) {
  return String(value || '').toLowerCase().normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function planKey(value) {
  return String(value || 'unspecified').toLowerCase().normalize('NFKC')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ') || 'unspecified';
}

function comparablePlanKey(value) {
  return planKey(value).replace(/\b(?:plan|tier|edition|customer platform)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function duplicatePlanMatch(left, right) {
  const a = comparablePlanKey(left);
  const b = comparablePlanKey(right);
  return a === b;
}

function makePrompt(sourceItems) {
  const blocks = sourceItems.map(({ source, entity }) => {
    const body = source.page_text || source.answer_text || '';
    return `SOURCE_ID: ${source.id || 'answer-text'}\n`
      + `ENTITY_HINT: ${entity || 'identify only if explicit'}\n`
      + `TITLE: ${source.title || 'Earlier answer'}\n`
      + 'UNTRUSTED_EVIDENCE_BEGIN\n'
      + `${excerptWindow(body, source.plan_hint || '')}\n`
      + 'UNTRUSTED_EVIDENCE_END';
  });
  return `${CLAIM_EXTRACTION_PROMPT}\n\nExtract from these evidence blocks only:\n\n${blocks.join('\n\n---\n\n')}`;
}

/** A target page must identify the requested entity in its title or opening text. */
export function pageMatchesEntity(source, entity, plans = {}) {
  const opening = String(source?.page_text || '').slice(0, 1_000);
  const identityText = `${source?.title || ''} ${opening}`;
  const normalText = normaliseEvidenceText(identityText);
  const tokens = new Set(normalText.split(/[^a-z0-9]+/).filter(Boolean));
  const key = normaliseEntity(entity);
  if (key.length >= 3 && ` ${normalText} `.includes(` ${key} `)) return true;
  return [...entityMatchCandidates(entity, plans)].some((candidate) => (
    candidate.length >= 3 && tokens.has(candidate)
  ));
}

/** Validates extracted claims against the exact page text before persisting them. */
export function validatePageClaims({ store, turnId, sourceItems, rawClaims, entityFilter = null, plans = {} }) {
  const pageItems = sourceItems.filter(({ source }) => source.page_text && source.retrieval_kind === 'page_text');
  const wrongPageSourceIds = pageItems.filter(({ source, entity }) => (
    entity && !pageMatchesEntity(source, entity, plans)
  )).map(({ source }) => source.id);
  const wrongPageIds = new Set(wrongPageSourceIds);
  for (const sourceId of wrongPageSourceIds) {
    store.updateSourceExtractionStatus?.(sourceId, 'wrong_page');
  }
  const pages = pageItems.filter(({ source }) => !wrongPageIds.has(source.id));
  let stored = 0;
  let rejected = 0;
  const saved = [];
  const seenClaims = new Map();
  for (const raw of Array.isArray(rawClaims) ? rawClaims : []) {
    const sourceItem = pages.find(({ source }) => source.id === raw.source_id);
    if (!sourceItem) { rejected += 1; continue; }
    const { source, entity: hint } = sourceItem;
    const rawQuote = String(raw.evidence_quote || '').slice(0, 300);
    const verbatim = findVerbatimSlice(source.page_text, rawQuote);
    if (!verbatim) {
      rejected += 1;
      continue;
    }
    const quote = verbatim;
    if (!quoteSupportsValueText(quote, raw.value_text) || !quoteContainsAmount(quote, raw.amount)) {
      rejected += 1;
      continue;
    }
    const assignedHint = hint && hint !== 'identify only if explicit' ? hint : raw.entity;
    const normalEntity = entityKey(assignedHint);
    if (!normalEntity || (entityFilter && normalEntity !== entityFilter)) { rejected += 1; continue; }
    const attribute = ['price', 'limit', 'version', 'release'].includes(raw.attribute) ? raw.attribute : null;
    if (!attribute) { rejected += 1; continue; }
    const resolvedPlan = supportedPlan(raw.plan_name, quote, normalEntity, plans);
    const duplicateKey = `${normalEntity}|${attribute}`;
    const duplicatePlans = seenClaims.get(duplicateKey) || [];
    if (duplicatePlans.some((existing) => duplicatePlanMatch(existing, resolvedPlan))) { rejected += 1; continue; }
    duplicatePlans.push(resolvedPlan);
    seenClaims.set(duplicateKey, duplicatePlans);
    const claim = {
      id: randomUUID(),
      turn_id: turnId,
      entity_key: normalEntity,
      attribute,
      plan_key: resolvedPlan,
      value_text: String(raw.value_text || '').slice(0, 200),
      amount: numberToken(raw.amount),
      currency: currencyFromQuote(raw.currency, quote, source.page_text),
      price_unit: attribute === 'price' ? canonicalPriceUnit(raw.price_unit, quote) : 'none',
      unit: supportedUnit(raw.unit, quote),
      period: attribute === 'price' || attribute === 'limit' ? periodFromQuote(raw.period, quote) : 'unknown',
      commitment: attribute === 'price'
        ? commitmentFromQuote(raw.commitment, quote, quoteContext(source.page_text, quote), resolvedPlan)
        : 'unknown',
      qualifiers: explicitQualifiers(raw.qualifiers, quote),
      evidence_quote: quote,
      source_id: source.id,
      observed_at_utc: source.retrieved_at_utc,
      baseline_basis: 'page_text',
    };
    try { saved.push(store.addClaim(claim)); stored += 1; } catch { rejected += 1; }
  }
  return { stored, rejected, claims: saved, wrongPageSourceIds };
}

function buildClaimExtractionBatches(sourceItems) {
  const pages = sourceItems.filter(({ source }) => source.page_text && source.retrieval_kind === 'page_text');
  const batches = [];
  let batch = [];
  let size = CLAIM_EXTRACTION_PROMPT.length;
  for (const item of pages) {
    const excerptLength = Math.min(12_000, String(item.source.page_text || '').length);
    if (batch.length && size + excerptLength + 400 > 40_000) {
      batches.push(batch);
      batch = [];
      size = CLAIM_EXTRACTION_PROMPT.length;
    }
    batch.push(item);
    size += excerptLength + 400;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function claimExtractionBatchCount(sourceItems) {
  return buildClaimExtractionBatches(sourceItems).length;
}

/** Extracts claims in bounded batches and validates quotes against the full stored page text. */
export async function extractPageClaims({
  store,
  turnId,
  sourceItems,
  budget,
  signal,
  entityFilter = null,
  plans = {},
  onTiming,
}) {
  const pages = sourceItems.filter(({ source }) => source.page_text && source.retrieval_kind === 'page_text');
  if (!pages.length) return { stored: 0, rejected: 0, claims: [] };

  const batches = buildClaimExtractionBatches(pages);
  if (budget.geminiCalls + batches.length > config.maxGeminiCalls) {
    throw new Error('Gemini call budget exhausted before evidence extraction.');
  }
  budget.geminiCalls += batches.length;
  const results = await Promise.all(batches.map((items) => generateJson({
    prompt: makePrompt(items),
    schema: CLAIM_SCHEMA,
    signal,
    onRetry: () => { budget.providerRetries = (budget.providerRetries || 0) + 1; },
    onTiming,
  })));
  const rawClaims = results.flatMap((result) => Array.isArray(result.claims) ? result.claims : []);
  return validatePageClaims({ store, turnId, sourceItems: pages, rawClaims, entityFilter, plans });
}

/** Validates claims against an unverified earlier answer; these can never produce Changed. */
function answerEntityHints(turn, supplied = []) {
  const source = `${turn?.user_text || ''}\n${turn?.assistant_text || ''}`;
  const capitalised = source.match(/\b[A-Z][A-Za-z0-9.+-]*(?:\s+[A-Z][A-Za-z0-9.+-]*){0,2}\b/g) || [];
  const ignored = new Set([
    'What', 'Which', 'When', 'Where', 'Why', 'How', 'The', 'This', 'That',
    'Compare', 'Check', 'Tell', 'Explain', 'Does', 'Can', 'Could', 'Should', 'Would',
    'Is', 'Are', 'Was', 'Were', 'Who', 'Earlier', 'Latest', 'Current',
    'Pricing', 'Price', 'Version', 'Limit',
  ]);
  const derived = capitalised.flatMap((value) => [value, value.split(/\s+/)[0]]);
  const candidateHints = [...new Set([...supplied, ...derived])]
    .map((value) => String(value || '').trim())
    .filter((value) => value && !ignored.has(value.split(/\s+/)[0]));
  return candidateHints;
}

const CATEGORY_WORDS = new Set([
  'crm', 'cloud', 'hosting', 'database', 'db', 'app', 'software', 'suite', 'platform', 'workspace',
]);

function isCategoryVariant(a, b) {
  const aWords = a.split(' ').filter(Boolean);
  const bWords = b.split(' ').filter(Boolean);
  const aNoCat = aWords.filter((w) => !CATEGORY_WORDS.has(w));
  const bNoCat = bWords.filter((w) => !CATEGORY_WORDS.has(w));
  const aBase = aNoCat.join(' ');
  const bBase = bNoCat.join(' ');
  if (!aBase || !bBase) return false;
  if (aBase === b && aWords.length > bWords.length) return true;
  if (bBase === a && bWords.length > aWords.length) return true;
  return false;
}

export function stripTrailingPlan(entity, rawPlanName = '', plans = {}) {
  let cleaned = entityKey(entity);
  if (!cleaned) return '';
  const planToken = planKey(rawPlanName);
  if (planToken && planToken !== 'unspecified' && cleaned.endsWith(` ${planToken}`)) {
    const prefix = cleaned.slice(0, cleaned.length - planToken.length - 1).trim();
    if (prefix.length >= 3) cleaned = prefix;
  }
  const knownPlanSuffixes = new Set([
    'starter', 'essential', 'standard', 'basic', 'growth',
    'launch', 'pro', 'professional', 'enterprise', 'team', 'free',
  ]);
  for (const entry of Object.values(plans || {})) {
    for (const alias of Object.keys(entry?.plan_aliases || {})) knownPlanSuffixes.add(planKey(alias));
    for (const target of Object.values(entry?.plan_aliases || {})) knownPlanSuffixes.add(planKey(target));
  }
  const words = cleaned.split(' ');
  if (words.length > 1 && knownPlanSuffixes.has(words.at(-1))) {
    const prefix = words.slice(0, -1).join(' ').trim();
    if (prefix.length >= 3) cleaned = prefix;
  }
  return cleaned;
}

export function matchEntityHint(extracted, hints = [], rawPlanName = '', plans = {}) {
  const activePlans = Object.keys(plans || {}).length ? plans : DEFAULT_PLANS;
  const entity = stripTrailingPlan(extracted, rawPlanName, activePlans);
  if (!entity) return '';

  const normalHints = [...new Set(
    hints.map((hint) => stripTrailingPlan(hint, rawPlanName, activePlans)).filter(Boolean)
  )];

  if (activePlans && Object.prototype.hasOwnProperty.call(activePlans, entity) && normalHints.includes(entity)) {
    return entity;
  }

  const entityWords = entity.split(' ').filter(Boolean);
  const isBareVendor = entityWords.length === 1;
  if (isBareVendor) {
    const vendorPrefix = `${entity} `;
    const prefixMatches = normalHints.filter((hint) => hint === entity || hint.startsWith(vendorPrefix));
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (prefixMatches.length > 1) return entity;
  }

  const entityBase = entity.split(' ').filter((w) => !CATEGORY_WORDS.has(w)).join(' ');
  if (
    entityBase !== entity
    && activePlans
    && Object.prototype.hasOwnProperty.call(activePlans, entityBase)
    && normalHints.includes(entityBase)
  ) {
    return entityBase;
  }

  if (normalHints.includes(entity)) return entity;

  const categoryMatches = normalHints.filter((hint) => isCategoryVariant(entity, hint));
  if (categoryMatches.length === 1) return categoryMatches[0];

  if (activePlans && Object.prototype.hasOwnProperty.call(activePlans, entity)) return entity;

  return entity;
}

export function validateAnswerClaims({ store, turn, rawClaims, plans = {}, entityHints = [] }) {
  let stored = 0;
  let rejected = 0;
  const saved = [];
  const seenClaims = new Map();
  for (const raw of Array.isArray(rawClaims) ? rawClaims : []) {
    const quote = String(raw.evidence_quote || '').slice(0, 300);
    if (
      !quote
      || !normaliseEvidenceText(turn.assistant_text).includes(normaliseEvidenceText(quote))
      || !quoteSupportsValueText(quote, raw.value_text)
      || !quoteContainsAmount(quote, raw.amount)
    ) {
      rejected += 1;
      continue;
    }
    const normalEntity = matchEntityHint(raw.entity, answerEntityHints(turn, entityHints), raw.plan_name, plans);
    if (!normalEntity || !['price', 'limit', 'version', 'release'].includes(raw.attribute)) {
      rejected += 1;
      continue;
    }
    const resolvedPlan = supportedPlan(raw.plan_name, quote, normalEntity, plans);
    const duplicateKey = `${normalEntity}|${raw.attribute}`;
    const duplicatePlans = seenClaims.get(duplicateKey) || [];
    if (duplicatePlans.some((existing) => duplicatePlanMatch(existing, resolvedPlan))) {
      rejected += 1;
      continue;
    }
    duplicatePlans.push(resolvedPlan);
    seenClaims.set(duplicateKey, duplicatePlans);
    const claim = {
      id: randomUUID(),
      turn_id: turn.id,
      entity_key: normalEntity,
      attribute: raw.attribute,
      plan_key: resolvedPlan,
      value_text: String(raw.value_text || '').slice(0, 200),
      amount: numberToken(raw.amount),
      currency: currencyFromQuote(raw.currency, quote),
      price_unit: raw.attribute === 'price' ? canonicalPriceUnit(raw.price_unit, quote) : 'none',
      unit: supportedUnit(raw.unit, quote),
      period: raw.attribute === 'price' || raw.attribute === 'limit' ? periodFromQuote(raw.period, quote) : 'unknown',
      commitment: raw.attribute === 'price'
        ? commitmentFromQuote(raw.commitment, quote, quoteContext(turn.assistant_text, quote, 200), resolvedPlan)
        : 'unknown',
      qualifiers: explicitQualifiers(raw.qualifiers, quote),
      evidence_quote: quote,
      source_id: null,
      observed_at_utc: turn.source_created_at_utc || turn.created_at_utc,
      baseline_basis: 'answer_text',
    };
    try { saved.push(store.addClaim(claim)); stored += 1; } catch { rejected += 1; }
  }
  store.updateTurn(turn.id, { claims_status: 'done' });
  return { stored, rejected, claims: saved };
}

/** Extracts numeric claims from imported or earlier live answer text, never treating it as page evidence. */
export async function extractAnswerBaseline({
  store,
  turn,
  budget,
  signal,
  plans = {},
  entityHints = [],
  onTiming,
}) {
  if (!turn?.assistant_text) {
    if (turn?.id) store.updateTurn(turn.id, { claims_status: 'done' });
    return { stored: 0, rejected: 0, claims: [] };
  }
  if (store.getClaimsForTurn(turn.id).length) {
    return { stored: 0, rejected: 0, claims: store.getClaimsForTurn(turn.id) };
  }
  if (budget.geminiCalls >= config.maxGeminiCalls) {
    throw new Error('Gemini call budget exhausted before earlier-answer extraction.');
  }
  budget.geminiCalls += 1;
  const hints = answerEntityHints(turn, entityHints).join(', ') || 'none';
  const prompt = `${CLAIM_EXTRACTION_PROMPT}\n\nEarlier answer text is unverified. `
    + 'Extract only explicitly stated claims.\n'
    + `ENTITY_HINTS (use these labels when they fit; do not merge unrelated entities): ${hints}\n`
    + `UNTRUSTED_ANSWER_BEGIN\n${turn.assistant_text.slice(0, 16_000)}\nUNTRUSTED_ANSWER_END`;
  const result = await generateJson({
    prompt,
    schema: CLAIM_SCHEMA,
    signal,
    onRetry: () => { budget.providerRetries = (budget.providerRetries || 0) + 1; },
    onTiming,
  });
  return validateAnswerClaims({ store, turn, rawClaims: result.claims, plans, entityHints });
}
