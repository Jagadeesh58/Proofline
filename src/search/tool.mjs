import { USER_STRINGS } from '../strings.mjs';
import { randomUUID } from 'node:crypto';
import { config } from '../config.mjs';
import { localDateFromUtc, localDateISO } from '../time/resolve.mjs';
import { isAggregator, normaliseEntity, registrableDomain, trustLabel } from '../seeds/domains.mjs';
import { tavilyExtract, tavilySearch } from './tavily.mjs';
import { excerptWindow, extractPageDate } from './excerpts.mjs';
import DEFAULT_PLANS from '../seeds/plans.json' with { type: 'json' };

export class ToolInputError extends Error { constructor(message) { super(message); this.code = 'invalid_tool_input'; } }

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function validateWebSearchInput(
  rawInput,
  todayUtc = new Date().toISOString().slice(0, 10),
) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new ToolInputError('web_search requires an object.');
  }
  const input = {
    ...rawInput,
    ...(Array.isArray(rawInput.queries)
      ? { queries: rawInput.queries.map((item) => (typeof item === 'string' ? { q: item } : item)) }
      : {}),
    ...(Array.isArray(rawInput.targets)
      ? {
        targets: rawInput.targets.flatMap((t) => {
          if (!t) return [];
          const cleanName = (typeof t.entity === 'string'
            ? t.entity.replace(/\b(pricing|price|prices|features?|news|announcements?|updates?|costs?|20\d\d)\b/gi, '')
              .trim().replace(/\s+/g, ' ')
            : null) || t.entity;
          if (Array.isArray(cleanName)) {
            return cleanName.map((entity) => ({ ...t, entity: String(entity) }));
          }
          return cleanName !== undefined ? [{ ...t, entity: String(cleanName) }] : [];
        }),
      }
      : {}),
  };
  const allowedTopLevel = ['queries', 'targets'];
  const extraTopLevel = Object.keys(input)
    .filter((key) => !allowedTopLevel.includes(key));
  if (extraTopLevel.length) {
    throw new ToolInputError(
      `The web_search input contains an unsupported field: ${extraTopLevel[0]}.`,
    );
  }
  const queries = input.queries ?? [];
  const targets = input.targets ?? [];
  if (!Array.isArray(queries) || !Array.isArray(targets)) {
    throw new ToolInputError('queries and targets must be arrays.');
  }
  if (queries.length > 6 || targets.length > 6) {
    throw new ToolInputError('The per-call limit is six queries and six targets.');
  }
  if (queries.length + targets.length === 0) {
    throw new ToolInputError('Provide at least one query or target.');
  }
  for (const query of queries) {
    const allowedFields = ['q', 'topic', 'since'];
    if (query && Object.keys(query).some((key) => !allowedFields.includes(key))) {
      throw new ToolInputError('A query contains an unsupported field.');
    }
    if (!query || typeof query.q !== 'string' || !query.q.trim() || query.q.length > 300) {
      throw new ToolInputError('Each query needs a non-empty q of at most 300 characters.');
    }
    if (!['general', 'news', undefined].includes(query.topic)) {
      throw new ToolInputError('topic must be general or news.');
    }
    const invalidSince = query.since !== undefined
      && (query.topic !== 'news' || !validDate(query.since) || query.since > todayUtc);
    if (invalidSince) {
      throw new ToolInputError(
        'since is a valid date no later than today and is allowed only on news queries.',
      );
    }
  }
  const allowedChecks = new Set(['pricing', 'limit', 'version', 'news']);
  for (const target of targets) {
    const allowedFields = ['entity', 'checks', 'since'];
    if (target && Object.keys(target).some((key) => !allowedFields.includes(key))) {
      throw new ToolInputError('A target contains an unsupported field.');
    }
    if (!target || typeof target.entity !== 'string'
      || !target.entity.trim() || target.entity.length > 120) {
      throw new ToolInputError('Each target needs an entity name.');
    }
    const invalidChecks = !Array.isArray(target.checks)
      || !target.checks.length
      || target.checks.some((check) => !allowedChecks.has(check));
    if (invalidChecks) {
      throw new ToolInputError('Each target needs one or more supported checks.');
    }
    if (!target.checks.includes('news') && target.since !== undefined) {
      throw new ToolInputError('since is allowed only on news targets.');
    }
    const invalidNewsSince = target.checks.includes('news')
      && target.since !== undefined
      && (!validDate(target.since) || target.since > todayUtc);
    if (invalidNewsSince) {
      throw new ToolInputError(
        'A news target needs a valid since date no later than today.',
      );
    }
  }
  return {
    queries: queries.map((query) => ({
      q: query.q.trim(),
      topic: query.topic || 'general',
      since: query.since,
    })),
    targets,
  };
}

function targetQueries(target) {
  const checks = new Set(target.checks);
  return [
    checks.has('pricing') ? `${target.entity} pricing` : null,
    checks.has('limit') ? `${target.entity} plan limits` : null,
    checks.has('version') ? `${target.entity} latest version release notes` : null,
  ].filter(Boolean);
}

function candidateScore(result, entity, plans = {}) {
  const trust = trustLabel(entity, result.url, plans);
  const trustScore = trust.label === USER_STRINGS.officialSiteVerified
    ? 100
    : trust.label === USER_STRINGS.nameMatchedDomainNotVerified ? 50 : 0;
  return trustScore + (isAggregator(result.url) ? -100 : 0)
    + Number(result.score || 0);
}

export function resolveTargetNewsSince(
  target,
  recallTurns,
  timezone,
  todayLocal = localDateISO(new Date(), timezone),
  options = {},
) {
  const targetName = normaliseEntity(target.entity);
  const strippedCategory = targetName
    .replace(/\b(crm|database|hosting|cloud|platform|app|software|suite)\b/gi, '').trim();
  const firstWord = targetName.split(' ')[0];
  const candidateKeys = [targetName, strippedCategory, firstWord].filter(Boolean);

  const baselineClaims = [...(options.baselineClaims || [])]
    .filter((claim) => candidateKeys.includes(claim.entity_key))
    .sort((a, b) => String(b.observed_at_utc || '').localeCompare(String(a.observed_at_utc || '')));
  const baselineClaim = baselineClaims[0] || null;
  const generationTime = (turn) => (turn.origin === 'imported'
    ? turn.source_created_at_utc : turn.created_at_utc);
  const baselineTime = baselineClaim
    ? (baselineClaim.origin === 'imported' && !baselineClaim.source_created_at_utc
      ? null
      : baselineClaim.source_created_at_utc || baselineClaim.created_at_utc || baselineClaim.observed_at_utc || null)
    : null;
  const baselineSince = baselineTime ? localDateFromUtc(baselineTime, timezone) : null;

  const matchingTurns = !targetName
    ? (recallTurns || [])
    : (recallTurns || []).filter((turn) => {
      const text = normaliseEntity(`${turn.user_text || ''} ${turn.assistant_text || ''}`);
      return candidateKeys.some((k) => text.includes(k));
    });
  const earlierGeneration = matchingTurns.map((turn) => ({ turn, generatedAt: generationTime(turn) }))
    .filter((item) => item.generatedAt)
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))[0] || null;

  if (options.explicitSince) {
    if (!validDate(options.explicitSince) || options.explicitSince > todayLocal) {
      return { since: null, baselineSince, explicitSince: null, unavailableReason: 'invalid_since' };
    }
    const generatedSince = earlierGeneration ? localDateFromUtc(earlierGeneration.generatedAt, timezone) : null;
    if (generatedSince && generatedSince < options.explicitSince) {
      const date = new Date(`${generatedSince}T00:00:00.000Z`);
      const displayDate = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC', day: 'numeric', month: 'short',
      }).format(date);
      const elapsedMs = Date.parse(`${todayLocal}T00:00:00.000Z`) - date.getTime();
      const gapDays = Math.max(0, Math.floor(elapsedMs / 86_400_000));
      return {
        since: generatedSince, baselineSince, explicitSince: options.explicitSince,
        unavailableReason: null, earlierGenerationDate: generatedSince,
        generationGapText: `Your earlier answer is from ${displayDate} (${gapDays} days ago).`,
      };
    }
    return {
      since: options.explicitSince,
      baselineSince,
      explicitSince: options.explicitSince,
      unavailableReason: null,
    };
  }
  if (baselineSince) {
    return { since: baselineSince, baselineSince, explicitSince: null, unavailableReason: null };
  }

  if (matchingTurns.length) {
    if (!earlierGeneration) {
      return {
        since: null,
        baselineSince: null,
        explicitSince: null,
        unavailableReason: 'generation_date_unknown',
      };
    }
    const since = localDateFromUtc(earlierGeneration.generatedAt, timezone);
    return { since, baselineSince: null, explicitSince: null, unavailableReason: null };
  }

  if (!target.since) {
    return {
      since: null,
      baselineSince: null,
      explicitSince: null,
      unavailableReason: 'missing_since',
    };
  }
  if (!validDate(target.since) || target.since > todayLocal) {
    return { since: null, baselineSince: null, explicitSince: null, unavailableReason: 'invalid_since' };
  }
  return { since: target.since, baselineSince: null, explicitSince: null, unavailableReason: null };
}

function makeSource(store, turnId, result, {
  pageText = null, origin = null, extractionStatus = 'ok', fromCache = false, retrievedAt = null,
} = {}) {
  const domain = registrableDomain(result.url);
  return store.addSource({
    id: randomUUID(), turnId, url: result.url, domain,
    title: result.title || result.url, providerDate: result.published_date || null,
    snippetText: result.content || '', pageText,
    retrievalKind: pageText ? 'page_text' : 'snippet', pageTextOrigin: origin,
    pageDateText: pageText ? extractPageDate(pageText) : null,
    retrievedAt: retrievedAt || new Date().toISOString(), extractionStatus,
    fromCache,
  });
}

function safeHttpUrl(value) {
  try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) ? url.toString() : null; }
  catch { return null; }
}

async function extractOne({
  url,
  results,
  store,
  turnId,
  budget,
  signal,
  entity,
  isCheckTarget = false,
  useCache = false,
  searchFn = tavilySearch,
  extractFn = tavilyExtract,
  allowRawFallback = true,
  providerErrors = [],
  onTiming,
}) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return null;
  if (budget.extracts >= config.maxExtracts) return null;
  budget.extracts += 1;
  const sourceMeta = (candidate) => {
    const candidateUrl = safeHttpUrl(candidate?.url);
    const isSameUrl = candidateUrl && safeUrl && candidateUrl === safeUrl;
    if (!isSameUrl && candidateUrl) {
      return {
        url: candidateUrl,
        title: candidate.title || candidateUrl,
        content: candidate.content || candidate.snippet || '',
        published_date: candidate.published_date || null,
      };
    }
    return {
      url: candidateUrl || safeUrl,
      title: candidate?.title || results?.title || safeUrl,
      content: candidate?.content || results?.content || '',
      published_date: candidate?.published_date || results?.published_date || null,
    };
  };
  if (!isCheckTarget && (extractFn === tavilyExtract || useCache)) {
    const cached = store?.getCachedPage?.(safeUrl);
    if (cached && cached.raw_content) {
      onTiming?.({ type: 'extract', url: safeUrl, duration_ms: 1, ok: true, cached: true });
      return makeSource(store, turnId, {
        url: safeUrl,
        title: results?.title || cached.title || safeUrl,
        content: cached.content || results?.content || '',
        published_date: results?.published_date || null,
      }, {
        pageText: cached.raw_content,
        origin: 'extract',
        fromCache: true,
        retrievedAt: cached.fetched_at_utc,
      });
    }
  }
  const extractStart = Date.now();
  try {
    const response = await extractFn(safeUrl, signal, () => {
      budget.providerRetries = (budget.providerRetries || 0) + 1;
    });
    onTiming?.({ type: 'extract', url: safeUrl, duration_ms: Date.now() - extractStart, ok: true });
    const found = (response.results || []).find((item) => safeHttpUrl(item.url) === safeUrl && item.raw_content);
    if (found?.raw_content) {
      const fetchedAtUtc = new Date().toISOString();
      if (extractFn === tavilyExtract || useCache) {
        store?.setCachedPage?.({
          url: safeUrl,
          title: sourceMeta(found).title,
          content: sourceMeta(found).content,
          raw_content: found.raw_content,
        });
      }
      return makeSource(store, turnId, sourceMeta(found), {
        pageText: found.raw_content,
        origin: 'extract',
        fromCache: false,
        retrievedAt: fetchedAtUtc,
      });
    }
  } catch (error) {
    onTiming?.({
      type: 'extract', url: safeUrl, duration_ms: Date.now() - extractStart, ok: false, error: error.message,
    });
    providerErrors.push(error);
    // Search raw-content is the bounded fallback for pages Extract cannot read.
  }

  if (!allowRawFallback || budget.searches >= config.maxSearches || signal?.aborted) return null;
  budget.searches += 1;
  const fallbackStart = Date.now();
  try {
    const parsed = new URL(safeUrl);
    const pathTerms = parsed.pathname.split('/').filter(Boolean).slice(-2).join(' ');
    const fallbackTerms = pathTerms || results?.title
      || parsed.hostname.replace(/^(?:www\.)?([^.]+).*/, '$1') || 'overview';
    let query = entity
      ? `${entity} ${results?.title || 'pricing plans'}`
      : `site:${parsed.hostname} ${fallbackTerms}`;
    if (!query.replace(/site:\S+/g, '').trim()) {
      query = `${query} information`;
    }
    const fallback = await searchFn({
      q: query,
      topic: 'general',
      includeRawContent: true,
      signal,
      onRetry: () => {
        budget.providerRetries = (budget.providerRetries || 0) + 1;
      },
    });
    onTiming?.({
      type: 'search', q: query, topic: 'general', duration_ms: Date.now() - fallbackStart, ok: true, fallback: true,
    });
    const candidates = (fallback.results || []).filter((item) => (
      typeof item.raw_content === 'string'
      && item.raw_content.length > 200
      && safeHttpUrl(item.url)
    ));
    const sameSite = candidates.find((item) => registrableDomain(item.url) === registrableDomain(safeUrl));
    const candidate = sameSite || candidates[0];
    if (!candidate) return null;
    const metadata = sourceMeta(candidate);
    return makeSource(store, turnId, metadata, { pageText: candidate.raw_content, origin: 'search_raw' });
  } catch (error) {
    onTiming?.({
      type: 'search', q: safeUrl, topic: 'general', duration_ms: Date.now() - fallbackStart,
      ok: false, error: error.message, fallback: true,
    });
    providerErrors.push(error);
    return null;
  }
}

async function resolveBaselineClaims(promise) {
  if (!promise) return { claims: [], baselinePending: false };
  let timer;
  try {
    const result = await Promise.race([
      promise.then((claims) => ({ claims, baselinePending: false })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ claims: [], baselinePending: true }), 5000); }),
    ]);
    return result;
  } catch { return { claims: [], baselinePending: false }; }
  finally { clearTimeout(timer); }
}

/** Runs the only model-visible tool. All URLs and provider data are stored before compact evidence is returned. */
export async function runWebSearch({
  rawInput,
  store,
  turnId,
  timezone,
  recallTurns = [],
  baselineClaimsPromise,
  explicitSince = null,
  budget,
  signal,
  plans = {},
  today = null,
  now = null,
  useCache = false,
  searchFn = tavilySearch,
  extractFn = tavilyExtract,
  onTiming,
}) {
  const todayLocal = today || localDateISO(now instanceof Date ? now : (now ? new Date(now) : new Date()), timezone);
  const input = validateWebSearchInput(rawInput, todayLocal);
  const baselineResolution = await resolveBaselineClaims(baselineClaimsPromise);
  const recalledClaims = baselineResolution.claims;
  const activePlans = Object.keys(plans || {}).length ? plans : DEFAULT_PLANS;
  const recalledEntityKeys = [...new Set((recalledClaims || []).map((c) => c.entity_key).filter(Boolean))];
  const queryEntityKeys = [];
  const knownVendors = Object.keys(activePlans);
  for (const qItem of input.queries) {
    const qLower = qItem.q.toLowerCase();
    for (const vendor of knownVendors) {
      if (new RegExp(String.raw`\b${vendor}\b`, 'i').test(qLower) && !queryEntityKeys.includes(vendor)) {
        queryEntityKeys.push(vendor);
      }
    }
  }
  const candidateKeys = [...new Set([...recalledEntityKeys, ...queryEntityKeys])];
  const CANONICAL_NAMES = {
    hubspot: 'HubSpot',
    pipedrive: 'Pipedrive',
    zoho: 'Zoho',
    monday: 'Monday',
    freshsales: 'Freshsales',
    neon: 'Neon',
    supabase: 'Supabase',
    aws: 'AWS RDS',
  };
  const targets = [...input.targets];
  if (targets.length === 0 && candidateKeys.length > 0 && candidateKeys.length <= 6) {
    for (const key of candidateKeys) {
      const entity = CANONICAL_NAMES[key] || (key.charAt(0).toUpperCase() + key.slice(1));
      targets.push({
        entity,
        checks: ['pricing', 'news'],
      });
    }
  }
  const calls = [];
  for (const query of input.queries) calls.push({ ...query, target: null, check: null });
  const targetContexts = [];
  const sourceTrust = {};
  const providerErrors = [];
  for (const target of targets) {
    const entity = normaliseEntity(target.entity);
    const claims = store.getClaimsForEntities([entity]);
    const baselineUrl = store.getBaselineUrl(claims);
    const staticQueries = targetQueries(target);
    const context = {
      ...target,
      entityKey: entity,
      baselineClaims: claims,
      baselineUrl,
      candidates: [],
      staticQueries,
      newsSources: [],
    };
    targetContexts.push(context);

    const matchingStaticCall = calls.find((call) => {
      if (call.target) return false;
      const qLower = call.q.toLowerCase();
      return qLower.includes(entity) || qLower.includes(target.entity.toLowerCase());
    });
    if (matchingStaticCall) {
      matchingStaticCall.target = context;
      matchingStaticCall.check = 'static';
    } else if (!baselineUrl) {
      for (const q of staticQueries) {
        if (budget.searches + calls.length < config.maxSearches) {
          calls.push({ q, topic: 'general', target: context, check: 'static' });
        }
      }
    }

    if (target.checks.includes('news')) {
      const resolved = resolveTargetNewsSince(
        target,
        recallTurns,
        timezone,
        todayLocal,
        { explicitSince, baselineClaims: claims },
      );
      if (resolved.unavailableReason === 'missing_since' || resolved.unavailableReason === 'invalid_since') {
        if (input.targets.length > 0) {
          throw new ToolInputError(`The news target for ${target.entity} needs a valid since date.`);
        }
      }
      context.newsUnavailableReason = resolved.unavailableReason;
      context.newsSince = resolved.since;
      context.baselineSince = resolved.baselineSince;
      context.explicitSince = resolved.explicitSince;
      context.earlierAnswerGap = resolved.generationGapText || null;
      if (resolved.since) {
        const matchingNewsCall = calls.find((call) => {
          if (call.target) return false;
          const qLower = call.q.toLowerCase();
          return call.topic === 'news' && (qLower.includes(entity) || qLower.includes(target.entity.toLowerCase()));
        });
        if (matchingNewsCall) {
          matchingNewsCall.target = context;
          matchingNewsCall.check = 'news';
        } else if (budget.searches + calls.length < config.maxSearches) {
          calls.push({
            q: `${target.entity} new features announcement`,
            topic: 'news',
            since: resolved.since,
            target: context,
            check: 'news',
          });
        }
      }
    }
  }
  if (budget.searches + calls.length > config.maxSearches) {
    const message = `This search would exceed the ${config.maxSearches}-search per-turn budget. `
      + 'Narrow the request; no searches were started.';
    throw new ToolInputError(message);
  }
  const targetExtracts = targetContexts.reduce((total, context) =>
    total + (context.baselineUrl || context.staticQueries.length ? 1 : 0), 0);
  const freeQueryExtracts = input.queries.length * config.maxExtractsPerQuery;
  const plannedExtracts = targetExtracts + freeQueryExtracts;
  if (budget.extracts + plannedExtracts > config.maxExtracts) {
    const message = `This search could require ${plannedExtracts} page extracts and would `
      + `exceed the ${config.maxExtracts}-extract per-turn budget. `
      + 'Narrow the request; no searches were started.';
    throw new ToolInputError(message);
  }
  budget.searches += calls.length;

  const searchStarted = Date.now();
  const searchResults = await mapConcurrent(calls, 3, async (call) => {
    const callStart = Date.now();
    try {
      const res = await searchFn({
        q: call.q, topic: call.topic, since: call.since, includeRawContent: call.topic === 'news', signal,
        onRetry: () => { budget.providerRetries = (budget.providerRetries || 0) + 1; },
      });
      onTiming?.({ type: 'search', q: call.q, topic: call.topic, duration_ms: Date.now() - callStart, ok: true });
      return { status: 'fulfilled', value: res };
    } catch (err) {
      onTiming?.({
        type: 'search', q: call.q, topic: call.topic, duration_ms: Date.now() - callStart,
        ok: false, error: err.message,
      });
      return { status: 'rejected', reason: err };
    }
  });
  const allSources = [];
  const freeQueryGroups = [];
  for (let index = 0; index < searchResults.length; index += 1) {
    const outcome = searchResults[index];
    const call = calls[index];
    if (outcome.status !== 'fulfilled') { providerErrors.push(outcome.reason); continue; }
    const group = [];
    for (const result of outcome.value.results || []) {
      const url = safeHttpUrl(result.url);
      if (!url) continue;
      const source = makeSource(store, turnId, result);
      group.push({ source, result });
      allSources.push(source);
      sourceTrust[source.id] = call.target
        ? trustLabel(call.target.entity, source.url, plans).label
        : USER_STRINGS.thirdParty;
      let pageSource = null;
      if (call.check === 'news' && typeof result.raw_content === 'string' && result.raw_content.length > 200) {
        pageSource = makeSource(store, turnId, result, { pageText: result.raw_content, origin: 'search_raw' });
        allSources.push(pageSource);
        sourceTrust[pageSource.id] = call.target
          ? trustLabel(call.target.entity, pageSource.url, plans).label
          : USER_STRINGS.thirdParty;
      }
      if (call.target) {
        if (call.check === 'news') call.target.newsSources.push({ source: pageSource || source, result });
        else call.target.candidates.push({ source, result });
      } else {
        for (const ctx of targetContexts) {
          const score = candidateScore(result, ctx.entity, plans);
          if (score > 0 || result.url.toLowerCase().includes(ctx.entityKey)) {
            ctx.candidates.push({ source, result });
            sourceTrust[source.id] = trustLabel(ctx.entity, source.url, plans).label;
          }
        }
      }
    }
    if (!call.target) freeQueryGroups.push(group);
  }

  const plannedTargetUrls = targetContexts.map((context) => {
    if (context.baselineUrl) return context.baselineUrl;
    const candidates = [...context.candidates].sort((left, right) => (
      candidateScore(right.result, context.entity, plans)
      - candidateScore(left.result, context.entity, plans)
    ));
    return candidates[0]?.result.url;
  }).filter(Boolean);
  const plannedFreeUrls = freeQueryGroups.flatMap((group) => (
    group.slice(0, config.maxExtractsPerQuery).map((item) => item.result.url)
  ));
  const uniquePlannedUrls = new Set([...plannedTargetUrls, ...plannedFreeUrls]);
  if (budget.extracts + uniquePlannedUrls.size > config.maxExtracts) {
    const message = `This search could require ${uniquePlannedUrls.size} page extracts and `
      + `would exceed the ${config.maxExtracts}-extract per-turn budget. `
      + 'Narrow the request; no page extracts were started.';
    throw new ToolInputError(message);
  }
  const targetPages = await mapConcurrent(targetContexts, 3, async (context) => {
    const plan = recalledClaims?.find((claim) => claim.entity_key === context.entityKey)?.plan_key
      || store.getClaimsForEntities([context.entityKey])
        .find((claim) => claim.entity_key === context.entityKey)?.plan_key
      || '';
    let pageSource = null;
    const isCheckTarget = Boolean(
      context.baselineUrl
      || context.since
      || context.newsSince
      || recalledClaims?.some((claim) => claim.entity_key === context.entityKey)
      || (store?.getClaimsForEntities && store.getClaimsForEntities([context.entityKey]).length > 0)
    );
    if (context.baselineUrl) {
      pageSource = await extractOne({
        url: context.baselineUrl,
        store,
        turnId,
        budget,
        signal,
        entity: context.entity,
        isCheckTarget: true,
        useCache,
        searchFn,
        extractFn,
        allowRawFallback: false,
        providerErrors,
        onTiming,
      });
      // A known baseline URL is extracted directly. Its failure does not trigger another search.
    } else {
      const candidates = [...context.candidates].sort((left, right) => (
        candidateScore(right.result, context.entity, plans)
        - candidateScore(left.result, context.entity, plans)
      ));
      const pick = candidates[0];
      if (pick) {
        pageSource = await extractOne({
          url: pick.result.url,
          results: pick.result,
          store,
          turnId,
          budget,
          signal,
          entity: context.entity,
          isCheckTarget,
          useCache,
          searchFn,
          extractFn,
          allowRawFallback: false,
          providerErrors,
          onTiming,
        });
      }
    }
    if (pageSource) {
      allSources.push(pageSource);
      sourceTrust[pageSource.id] = trustLabel(context.entity, pageSource.url, plans).label;
    }
    const news = context.newsSources.map(({ source }) => ({
      source_id: source.id,
      title: source.title,
      url: source.url,
      provider_date: source.provider_date,
      snippet: source.snippet_text,
    }));
    return {
      entity: context.entity, entity_key: context.entityKey, checks: context.checks,
      since: context.newsSince || null,
      baseline_since: context.baselineSince || null,
      explicit_since: context.explicitSince || null,
      earlier_answer_gap: context.earlierAnswerGap || null,
      page: pageSource ? {
        source_id: pageSource.id, title: pageSource.title, url: pageSource.url,
        domain: pageSource.registrable_domain, trust: trustLabel(context.entity, pageSource.url, plans).label,
        page_date_text: pageSource.page_date_text,
        excerpt: excerptWindow(pageSource.page_text, plan),
      } : null,
      news, news_unavailable_reason: context.newsUnavailableReason || null,
    };
  });

  const extractedUrls = new Set(targetContexts.map((context) => context.baselineUrl).filter(Boolean));
  const freeExtractTasks = [];
  for (const group of freeQueryGroups) {
    for (const item of group.slice(0, config.maxExtractsPerQuery)) {
      if (extractedUrls.has(item.result.url)) continue;
      extractedUrls.add(item.result.url);
      freeExtractTasks.push(extractOne({
        url: item.result.url,
        results: item.result,
        store,
        turnId,
        budget,
        signal,
        useCache,
        searchFn,
        extractFn,
        providerErrors,
        onTiming,
      })
        .then((page) => {
          if (page) {
            allSources.push(page);
            sourceTrust[page.id] = USER_STRINGS.thirdParty;
          }
          return page;
        }));
    }
  }
  await Promise.all(freeExtractTasks);

  const storedSources = store.getSources(turnId);
  const serialSources = storedSources.map((source, index) => ({
    source_id: source.id, citation_id: `S${index + 1}`, title: source.title, url: source.url,
    domain: source.registrable_domain, retrieval_kind: source.retrieval_kind,
    provider_date: source.provider_date, snippet: source.snippet_text,
    excerpt: source.page_text ? excerptWindow(source.page_text) : null,
    retrieved_at_utc: source.retrieved_at_utc,
  }));
  return {
    ok: true, elapsed_ms: Date.now() - searchStarted,
    query_count: calls.length, search_calls_remaining: config.maxSearches - budget.searches,
    extracts_remaining: config.maxExtracts - budget.extracts,
    targets: targetPages, sources: serialSources, sourceTrust, baseline_pending: baselineResolution.baselinePending,
    provider_errors: providerErrors.slice(0, 5).map((error) => ({
      status: Number(error?.status) || 0,
      message: String(error?.message || 'Provider request failed.').slice(0, 200),
    })),
    note: 'Search snippets are leads, not verified page evidence. Use only these source IDs in citations.',
  };
}
