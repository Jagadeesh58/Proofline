import { USER_STRINGS } from '../strings.mjs';
import { splitSentences } from './answer-stream.mjs';
import { evaluateSearchPolicy } from '../agent/search-policy.mjs';

const MONTH_NAME_PATTERN = [
  String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|`,
  String.raw`may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|`,
  String.raw`oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`,
].join('');

const CURRENCY_FIGURE_PATTERN = [
  String.raw`(?:[$₹€£]\s?\d[\d,]*(?:\.\d+)?)`,
  String.raw`|\b(?:USD|INR|EUR|GBP|CAD|AUD|SGD|JPY|Rs\.?)\s?\d[\d,]*(?:\.\d+)?`,
  String.raw`|\b\d[\d,]*(?:\.\d+)?\s?`,
  String.raw`(?:USD|INR|EUR|GBP|CAD|AUD|SGD|JPY|rupees?|euros?|pounds?|dollars?)`,
].join('');

const FIGURE_PATTERNS = [
  new RegExp(CURRENCY_FIGURE_PATTERN, 'gi'),
  /\b\d+(?:\.\d+){1,3}\b/g,
  /\b\d+(?:[,.]\d+)?\s?%/g,
  new RegExp([
    String.raw`\b\d+(?:[,.]\d+)?\s?(?:gb|tb|mb|users?|seats?|contacts?|requests?|`,
    String.raw`api calls?|members?|agents?|hosts?|people|persons?)\b`,
  ].join(''), 'gi'),
  /\b\d{1,4}[- ]person\b/gi,
  /\b20\d{2}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(String.raw`\b\d{1,2}\s+${MONTH_NAME_PATTERN}(?:\s+20\d{2})?\b`, 'gi'),
  new RegExp(String.raw`\b${MONTH_NAME_PATTERN}\s+\d{1,2}(?:,?\s+20\d{2})?\b`, 'gi'),
  new RegExp(String.raw`\b\d{1,2}\s+${MONTH_NAME_PATTERN}\s+20\d{2}\b`, 'gi'),
];

function numberFromToken(token) {
  const match = token.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}


const MONTHS = new Map(
  ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    .map((month, index) => [month, index + 1]),
);

function parseDateToken(value) {
  const text = String(value || '').trim().replace(/,/g, '');
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = text.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(20\d{2}))?$/i)
    || text.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(20\d{2}))?$/i);
  if (!match) return null;
  const dayFirst = /^\d/.test(match[1]);
  const day = Number(dayFirst ? match[1] : match[2]);
  const monthText = (dayFirst ? match[2] : match[1]).slice(0, 3).toLowerCase();
  const month = MONTHS.get(monthText);
  if (!month || day < 1 || day > 31) return null;
  return { year: match[3] ? Number(match[3]) : null, month, day };
}

function dateMentions(text) {
  const source = String(text || '');
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    new RegExp(String.raw`\b\d{1,2}\s+${MONTH_NAME_PATTERN}(?:\s+20\d{2})?\b`, 'gi'),
    new RegExp(String.raw`\b${MONTH_NAME_PATTERN}\s+\d{1,2}(?:,?\s+20\d{2})?\b`, 'gi'),
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)]
    .map((match) => ({ raw: match[0], parsed: parseDateToken(match[0]) }))
    .filter((item) => item.parsed));
}

function dateSupported(token, context) {
  const wanted = parseDateToken(token);
  if (!wanted) return false;
  const recalledText = (context.recalled || []).flatMap((turn) => [
    turn.user_text || '', turn.assistant_text || '',
  ]);
  const sourceDates = (context.sources || []).flatMap((source) => [
    source.provider_date || '', source.page_date_text || '',
    source.excerpt_text || source.excerpt || '',
  ]);
  const texts = [context.userText || '', ...recalledText, ...sourceDates, ...(context.sinceDates || [])];
  return texts.some((text) => dateMentions(text).some(({ parsed }) => (
    parsed.month === wanted.month && parsed.day === wanted.day
    && (wanted.year == null || parsed.year === wanted.year)
  )));
}

function planMention(sentence, claim) {
  const plan = String(claim.plan_key || '').replaceAll('_', ' ').trim();
  return plan && new RegExp(`\\b${escapeRegExp(plan)}\\b`, 'i').test(sentence);
}

function excerptFor(source) {
  return source.excerpt_text || source.excerpt || '';
}

function sentenceFigures(sentence) {
  const found = [];
  for (const pattern of FIGURE_PATTERNS) {
    for (const match of sentence.matchAll(pattern)) {
      const token = match[0];
      if (/^20\d{2}$/.test(token) && /RFC\s+\d+/i.test(sentence)) continue;
      found.push(token);
    }
  }
  return [...new Set(found)];
}

export function hasFigureTokens(sentence) {
  return sentenceFigures(String(sentence || '')).length > 0;
}

function sentenceEntities(sentence, entities) {
  return entities.filter((entity) => {
    const name = String(entity.name || '').trim();
    const key = String(entity.key || '').trim();
    const words = `${name} ${key}`.toLowerCase().split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3
        && !['crm','postgres','database','cloud','platform','app'].includes(word));
    const exactName = name && new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(sentence);
    const exactKey = key && new RegExp(`\\b${escapeRegExp(key)}\\b`, 'i').test(sentence);
    return exactName || exactKey || words.some((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(sentence));
  });
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function containsToken(text, token) {
  const normalized = String(text || '').toLowerCase().replace(/,/g, '');
  const value = String(token || '').toLowerCase().trim();
  const currency = value.match(
    /^(?:([$₹€£])\s*([\d,]+(?:\.\d+)?)|([a-z.]+)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*([a-z.]+))$/i,
  );
  if (currency) {
    // INR symbols, ISO codes and rupee spellings share one currency code for evidence matching.
    const symbolCurrencies = { '$': 'USD', '₹': 'INR', '€': 'EUR', '£': 'GBP' };
    const codeAliases = {
      USD: '(?:\\$|usd|us dollars?|dollars?)',
      INR: '(?:₹|inr|rs\\.?|rupees?)',
      EUR: '(?:€|eur|euros?)',
      GBP: '(?:£|gbp|pounds?(?: sterling)?)',
      CAD: '(?:cad|canadian dollars?)',
      AUD: '(?:aud|australian dollars?)',
      SGD: '(?:sgd|singapore dollars?)',
      JPY: '(?:¥|jpy|yen)',
    };
    let code;
    let rawAmount;
    if (currency[1]) {
      code = symbolCurrencies[currency[1]];
      rawAmount = currency[2];
    } else if (currency[3]) {
      const rawCode = currency[3].replace(/\./g, '').toUpperCase();
      code = ({ RS: 'INR', RUPEE: 'INR', RUPEES: 'INR', EURO: 'EUR', EUROS: 'EUR',
        POUND: 'GBP', POUNDS: 'GBP', DOLLAR: 'USD', DOLLARS: 'USD' })[rawCode] || rawCode;
      rawAmount = currency[4];
    } else {
      rawAmount = currency[5];
      const rawCode = currency[6].replace(/\./g, '').toUpperCase();
      code = ({ RS: 'INR', RUPEE: 'INR', RUPEES: 'INR', EURO: 'EUR', EUROS: 'EUR',
        POUND: 'GBP', POUNDS: 'GBP', DOLLAR: 'USD', DOLLARS: 'USD' })[rawCode] || rawCode;
    }
    const alias = codeAliases[code];
    if (!alias) return false;
    const amount = escapeRegExp(rawAmount.replace(/,/g, ''));
    return new RegExp(`${alias}\\s*${amount}(?![\\d.])`, 'i').test(normalized)
      || new RegExp(`(?<![\\d.])${amount}\\s*${alias}(?![a-z])`, 'i').test(normalized);
  }

  const percent = value.match(/^([\d,]+(?:\.\d+)?)\s*%$/);
  if (percent) {
    const amount = escapeRegExp(percent[1].replace(/,/g, ''));
    return new RegExp(`(?<![\\d.])${amount}\\s*%`, 'i').test(normalized)
      || new RegExp(`(?<![\\d.])${amount}\\s*percent`, 'i').test(normalized);
  }

  const unitPattern = [
    String.raw`^([\d,]+(?:\.\d+)?)\s*`,
    String.raw`(gb|tb|mb|users?|seats?|contacts?|requests?|api calls?|members?|agents?|hosts?|people|persons?)$`,
  ].join('');
  const unit = value.match(new RegExp(unitPattern, 'i'));
  if (unit) {
    const amount = escapeRegExp(unit[1].replace(/,/g, ''));
    const rawUnit = unit[2].toLowerCase();
    const canonical = /^(?:user|seat|contact|member|agent|host)s?$/.test(rawUnit) ? rawUnit.replace(/s$/, '')
      : rawUnit === 'persons' || rawUnit === 'people' ? '(?:person|people|persons)'
      : rawUnit.replace(/s$/, '');
    const unitPattern = canonical.startsWith('(?:') ? canonical : escapeRegExp(canonical) + 's?';
    return new RegExp(`(?<![\\d.])${amount}\\s*${unitPattern}\\b`, 'i').test(normalized);
  }

  const person = value.match(/^([\d,]+)\s*[- ]person$/);
  if (person) {
    const amount = escapeRegExp(person[1].replace(/,/g, ''));
    return new RegExp(`(?<![\\d.])${amount}\\s*[- ]?(?:person|people|persons)\\b`, 'i').test(normalized);
  }

  if (/^20\d{2}$/.test(value)) return new RegExp(`\\b${escapeRegExp(value)}\\b`).test(normalized);
  if (/^\d+(?:\.\d+){1,3}$/.test(value)) {
    const pattern = new RegExp(`(?<![\\d.])${escapeRegExp(value)}(?![\\d.])`);
    return pattern.test(normalized);
  }
  return normalized.includes(value.replace(/,/g, ''));
}

function contextForEntity(entity, context) {
  if (!entity) return {
    claims: context.claims || [],
    pages: context.sources?.filter((source) => source.excerpt_text || source.excerpt) || [],
    snippets: context.sources?.filter((source) => source.retrieval_kind === 'snippet') || [],
  };
  const sources = context.sources || [];
  const titlePattern = new RegExp(
    `\\b${escapeRegExp(entity.name.toLowerCase())}\\b`, 'i',
  );
  const keyPattern = new RegExp(
    `\\b${escapeRegExp(entity.key.toLowerCase().split(' ')[0])}\\b`, 'i',
  );
  const titleMatches = (source) => titlePattern.test(String(source.title))
    || keyPattern.test(String(source.title));
  return {
    claims: (context.claims || []).filter((claim) => claim.entity_key === entity.key),
    pages: sources.filter((source) => (source.excerpt_text || source.excerpt)
      && (source.registrable_domain === entity.domain || titleMatches(source))),
    snippets: sources.filter((source) => source.retrieval_kind === 'snippet'
      && titleMatches(source)),
  };
}

function calculatedValues(entity, context) {
  const values = new Set();
  if (!entity) return values;
  const match = String(context.userText || '').match(
    /\b(\d{1,4})\s*[- ]?(?:person|people|user|seat|member|agent|host)s?\b/i,
  );
  if (match) {
    const seats = Number(match[1]);
    for (const claim of context.claims || []) {
      if (claim.entity_key !== entity.key || claim.attribute !== 'price'
        || claim.price_unit !== 'per_seat' || claim.amount === null) continue;
      values.add(seats * Number(claim.amount));
    }
  }
  return values;
}

function splitEntityClauses(sentence, entities) {
  const labels = entities.flatMap((entity) => [entity.name, entity.key]).filter(Boolean)
    .map((label) => escapeRegExp(label)).filter(Boolean);
  if (!labels.length) return [sentence];
  const nextEntity = `(?:${labels.join('|')})`;
  const separated = sentence
    .replace(new RegExp(`\\s+and\\s+(?=${nextEntity}\\b)`, 'gi'), '\n')
    .replace(/\s+(?:while|whereas|but|versus|vs\.?)\s+/gi, '\n')
    .replace(/[,;]\s*(?=[A-Z])/g, '\n');
  return separated.split('\n').map((part) => part.trim()).filter(Boolean);
}


function namedFreeformEntities(sentence) {
  const stop = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'according', 'published', 'reported']);
  const leading = String(sentence || '').match(/^\s*([A-Z][A-Za-z0-9.+-]*(?:\s+[A-Z][A-Za-z0-9.+-]*){0,3})\b/);
  if (!leading) return [];
  const phrase = leading[1].split(/\s+/).filter((word) => !stop.has(word.toLowerCase()));
  return phrase.length ? [phrase.map((word) => word.toLowerCase())] : [];
}

function sourceMatchesNamedEntity(source, sentence) {
  const title = String(source.title || '').toLowerCase();
  const domain = String(source.registrable_domain || source.domain || '').toLowerCase().split('.')[0];
  const named = namedFreeformEntities(sentence);
  if (!named.length) return true;
  const searchable = `${title} ${domain}`;
  return named.some((phrase) => phrase.some((word) => word.length >= 3
    && new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(searchable)));
}

function evidenceSupportsFigure(token, sentence, context, entities) {
  const named = sentenceEntities(sentence, entities);
  let scopes = named;
  if (named.length > 1) {
    const lower = sentence.toLowerCase();
    const figureIndex = lower.indexOf(token.toLowerCase());
    const positions = named.map((entity) => {
      const aliases = [entity.name, entity.key].filter(Boolean)
        .map((alias) => lower.indexOf(alias.toLowerCase()))
        .filter((index) => index >= 0);
      return { entity, index: aliases.length ? Math.min(...aliases) : Number.MAX_SAFE_INTEGER };
    });
    const preceding = positions.filter((item) => item.index <= figureIndex).sort((a,b) => b.index - a.index);
    const following = positions.filter((item) => item.index > figureIndex).sort((a,b) => a.index - b.index);
    scopes = [((preceding[0] || following[0] || positions[0]).entity)];
    if (/\b(?:both|each|all)\b/i.test(sentence)) scopes = named;
  }

  let snippetOnly = false;
  if (!scopes.length) {
    const hasNamedEntity = namedFreeformEntities(sentence).length > 0;
    const pages = (context.sources || []).filter((source) => (source.excerpt_text || source.excerpt)
      && (!hasNamedEntity || sourceMatchesNamedEntity(source, sentence)));
    const excerptMatch = pages.some((source) => containsToken(excerptFor(source), token));
    if (excerptMatch) return { supported: true, snippetOnly: false };
    const snippets = (context.sources || []).filter((source) => source.retrieval_kind === 'snippet'
      && (!hasNamedEntity || sourceMatchesNamedEntity(source, sentence)));
    snippetOnly = snippets.some((source) => containsToken(source.snippet_text, token));
    const recalledText = (context.recalled || []).map((turn) => (
      `${turn.user_text || ''}\n${turn.assistant_text || ''}`
    )).join('\n');
    const userAndMemory = `${context.userText || ''}\n${recalledText}`;
    if (containsToken(userAndMemory, token)) return { supported: true, snippetOnly: false };
    const numVal = numberFromToken(token);
    if (numVal !== null && numericWasSuppliedOrCalculated(numVal, context.userText)) {
      return { supported: true, snippetOnly: false };
    }
    return { supported: false, snippetOnly };
  }

  for (const entity of scopes) {
    const evidence = contextForEntity(entity, context);
    const entityClaims = evidence.claims;
    const namedPlans = entityClaims.filter((claim) => planMention(sentence, claim));
    const claimsToCheck = namedPlans.length ? namedPlans : entityClaims;
    const claimMatches = claimsToCheck.some((claim) => containsToken(claim.value_text, token));
    if (claimMatches) return { supported: true, snippetOnly: false };

    // A validated claim for the named plan takes precedence over any other plan on its page.
    const claimConflict = claimsToCheck.length > 0;
    const excerptMatch = !claimConflict && evidence.pages.some((page) => containsToken(excerptFor(page), token));
    if (excerptMatch) return { supported: true, snippetOnly: false };
    if (evidence.snippets.some((source) => containsToken(source.snippet_text, token))) snippetOnly = true;
  }

  const recalledText = (context.recalled || []).map((turn) => (
    `${turn.user_text || ''}\n${turn.assistant_text || ''}`
  )).join('\n');
  const userAndMemory = `${context.userText || ''}\n${recalledText}`;
  if (containsToken(userAndMemory, token)) return { supported: true, snippetOnly: false };
  const calculatedMatch = scopes.some((entity) => /^[$₹€£]/.test(token)
    && [...calculatedValues(entity, context)].some((number) => (
      Math.abs(Number(number) - Number(numberFromToken(token))) < 0.000001
    )));
  if (calculatedMatch) return { supported: true, snippetOnly: false };
  return { supported: false, snippetOnly };
}

function isCurrentDateToken(token, sentence, context) {
  if (!context.today) return false;
  const [year, month, day] = context.today.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const enGb = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
  }).format(date);
  const enUs = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
  }).format(date);
  const dayFirst = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  const monthFirst = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
  const forms = [context.today, enGb, enUs, dayFirst, monthFirst];
  const sentenceHasDate = forms.some((form) => sentence.toLowerCase().includes(form.toLowerCase()));
  if (!sentenceHasDate) return false;
  return token === String(year) || forms.some((form) => form.toLowerCase() === token.toLowerCase());
}

/** Marks unsupported figures sentence-by-sentence. A snippet-only match is explicitly not verified. */
export function checkAnswerFigures(text, context) {
  const sentences = splitSentences(text);
  const output = [];
  const markers = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const separator = index < sentences.length - 1 ? ' ' : '';
    const figures = sentenceFigures(sentence);
    if (!figures.length) { output.push(sentence + separator); continue; }
    const todayParts = context.today ? context.today.split('-') : [];
    const todayDate = todayParts.length === 3
      ? new Date(Date.UTC(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2])))
      : null;
    const todayDisplay = todayDate
      ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
      }).format(todayDate)
      : '';
    const sentenceHasToday = todayDisplay && sentence.toLowerCase().includes(todayDisplay.toLowerCase())
      && figures.every((token) => token === todayParts[0] || token.toLowerCase().includes(todayDisplay.toLowerCase()));
    const allTokensAreToday = context.today && figures.every((token) => (
      token === context.today || isCurrentDateToken(token, sentence, context)
    ));
    if (sentenceHasToday || allTokensAreToday) {
      output.push(sentence + separator);
      continue;
    }
    const entities = context.entities || [];
    const clauses = splitEntityClauses(sentence, entities);
    let unsupported = false;
    let snippetOnly = false;
    for (const clause of clauses) {
      for (const token of sentenceFigures(clause)) {
        if (parseDateToken(token)) { if (!dateSupported(token, context)) unsupported = true; continue; }
        const clauseDates = dateMentions(clause);
        if (/^20\d{2}$/.test(token)
          && clauseDates.some((date) => date.parsed.year === Number(token))) continue;
        if (isCurrentDateToken(token, clause, context)) continue;
        const result = evidenceSupportsFigure(token, clause, context, entities);
        if (!result.supported) unsupported = true;
        if (result.snippetOnly) snippetOnly = true;
      }
    }
    if (unsupported) {
      const markerText = snippetOnly
        ? USER_STRINGS.searchSnippetPageNotVerified
        : USER_STRINGS.figureNotVerified;
      const marker = ` ${markerText}`;
      output.push(sentence.trimEnd() + marker + separator);
      markers.push({ sentence: sentence.trim(), marker: marker.trim() });
    } else output.push(sentence + separator);
  }
  return { text: output.join(''), markers };
}

function numericValues(text) {
  return [...String(text || '').matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)]
    .map((match) => Number(match[0].replace(/,/g, ''))).filter(Number.isFinite);
}

function arithmeticResults(userText) {
  const results = new Set();
  const text = String(userText || '');
  const pattern = new RegExp(
    String.raw`(\d+(?:\.\d+)?)\s*(?:times|multiplied by|\*|[x×]|`
      + String.raw`plus|\+|minus|\-|divided by|\/)\s*(\d+(?:\.\d+)?)`,
    'gi',
  );
  for (const match of text.matchAll(pattern)) {
    const left = Number(match[1]);
    const right = Number(match[2]);
    const operator = match[0].slice(match[1].length, match[0].length - match[2].length).trim().toLowerCase();
    let result;
    if (/times|multiplied by|\*|^[x×]$/.test(operator)) result = left * right;
    else if (/plus|\+/.test(operator)) result = left + right;
    else if (/minus|^-/.test(operator)) result = left - right;
    else if (/divided by|\//.test(operator) && right !== 0) result = left / right;
    if (Number.isFinite(result)) results.add(result);
  }
  const seatMatch = text.match(/(\d+)\s*(?:seats?|users?|people|members?)/i);
  const rateMatch = text.match(/[$₹€£]?\s*(\d+(?:\.\d+)?)\s*(?:per\s*(?:month|seat|user)|\/month|\/seat|\/user)/i);
  if (seatMatch && rateMatch) {
    const seats = Number(seatMatch[1]);
    const rate = Number(rateMatch[1]);
    if (seats > 0 && rate > 0) {
      results.add(seats * rate);
      results.add(seats * rate * 12);
    }
  }
  return results;
}

function numericWasSuppliedOrCalculated(value, userText) {
  const supplied = numericValues(userText);
  if (supplied.some((number) => Math.abs(number - value) < 0.000001)) return true;
  return [...arithmeticResults(userText)].some((number) => Math.abs(number - value) < 0.000001);
}

/** Scans a buffered direct draft, ignoring figures explicitly supplied or calculated by the user. */
export function hasMutableFactSignal(draft, { userText = '' } = {}) {
  if (!evaluateSearchPolicy(userText).shouldSearch) {
    return false;
  }
  const text = String(draft || '');
  const user = String(userText || '');
  const currencyPattern = new RegExp([
    String.raw`(?:[$₹€£]\s?\d[\d,.]*`,
    String.raw`|\b(?:USD|INR|EUR|GBP|CAD|AUD|SGD|JPY|Rs\.?)\s?\d[\d,.]*`,
    String.raw`|\b\d[\d,.]*\s?`,
    String.raw`(?:USD|INR|EUR|GBP|CAD|AUD|SGD|JPY|rupees?|euros?|pounds?|dollars?))`,
  ].join(''), 'gi');
  for (const match of text.matchAll(currencyPattern)) {
    const amount = numberFromToken(match[0]);
    if (amount === null || !numericWasSuppliedOrCalculated(amount, user)) return true;
  }
  for (const match of text.matchAll(/\b\d+(?:[,.]\d+)?\s?%/g)) {
    const sentences = splitSentences(text);
    let offset = 0;
    let sentence = '';
    for (const s of sentences) {
      if (match.index >= offset && match.index < offset + s.length) {
        sentence = s;
        break;
      }
      offset += s.length;
    }
    const mutableMarketTerms = new RegExp([
      String.raw`\b(?:price|pricing|plan|rate|share|growth|market|fee|revenue|margin|`,
      String.raw`discount|tax|commission|conversion|interest|usage|limit|quota|increase|decrease)\b`,
    ].join(''), 'i');
    if (mutableMarketTerms.test(sentence)) {
      const amount = numberFromToken(match[0]);
      if (amount === null || !numericWasSuppliedOrCalculated(amount, user)) return true;
    }
  }
  for (const match of text.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b/g)) {
    const before = text.slice(Math.max(0, match.index - 28), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 20);
    const hasVersionPrefix = /\b(?:v|version|release)\s*$/i.test(before);
    const hasProductPrefix = /\b[A-Z][A-Za-z0-9_-]*\s*$/u.test(before);
    const hasVersionSuffix = /^\s*(?:version|release)\b/i.test(after);
    const isVersion = hasVersionPrefix || hasProductPrefix || hasVersionSuffix;
    if (isVersion) return true;
  }
  const hasRecentYear = /\b20(?:2[4-9]|3\d)\b/.test(text);
  const hasYearStatus = /\b(released|updated|launched|announced|latest|version|since|as of)\b/i.test(text);
  if (hasRecentYear && hasYearStatus) return true;
  const recencyPattern = new RegExp([
    String.raw`\b(?:latest|currently|recently|right now|as of today|as of \w+|`,
    String.raw`still\s+(?:costs|priced|free|available|supports|the ceo))\b`,
  ].join(''), 'i');
  if (recencyPattern.test(text)) return true;
  const currentFactPattern = new RegExp([
    String.raw`\b(?:current|latest|newest)\s+(?:api\s+)?`,
    String.raw`(?:limits?|quotas?|pricing|prices?|versions?|features?|availability|plans?)\b`,
  ].join(''), 'i');
  if (currentFactPattern.test(text)) return true;
  const leadershipRoles = String.raw`(?:ceo|chief executive officer|cto|cfo|founder|president|chairperson|chair|owner)`;
  const leadershipPattern = new RegExp([
    String.raw`\b(?:is|was|remains|serves as)\s+(?:the\s+)?${leadershipRoles}\b|`,
    String.raw`\b${leadershipRoles}\s+is\b`,
  ].join(''), 'i');
  if (leadershipPattern.test(text)) return true;
  const recentChangePattern = new RegExp(
    String.raw`\b(?:released|updated|launched|announced|shipped|changed)\b`,
    'i',
  );
  const recentWindowPattern = /\b(?:since|this week|this month|recently|latest)\b/i;
  const recentChange = text.match(recentChangePattern);
  if (recentChange && recentWindowPattern.test(text.slice(recentChange.index, recentChange.index + 90))) {
    return true;
  }
  const quantityPattern = /\b\d+\s?(?:seats?|users?|gb|tb|requests?|contacts?)\b/i;
  const productContextPattern = /\b(?:plan|tier|price|cost|product|company)\b/i;
  if (quantityPattern.test(text) && productContextPattern.test(text)) return true;
  return false;
}
