import { randomUUID } from 'node:crypto';
import { config, userFacing, isSearchReady } from '../config.mjs';
import { SYSTEM_PROMPT } from './prompts.mjs';
import { buildSystemContext, conversationContents } from './context.mjs';
import { evaluateSearchPolicy } from './search-policy.mjs';
import { recallForTurn } from './recall.mjs';
import { buildRecallPreface } from './recall-preface.mjs';
import { claimExtractionBatchCount, extractAnswerBaseline, extractPageClaims } from '../evidence/claims.mjs';
import { buildComparisonCards } from '../evidence/compare.mjs';
import { checkAnswerFigures, hasMutableFactSignal } from '../evidence/figure-check.mjs';
import { createSentenceGate } from '../evidence/answer-stream.mjs';
import { generateStream, webSearchDeclaration, ProviderError } from '../llm/gemini.mjs';
import { runWebSearch, ToolInputError } from '../search/tool.mjs';
import { isValidTimezone, localDateISO, resolveSinceDate } from '../time/resolve.mjs';
import { trustLabel } from '../seeds/domains.mjs';
import { getReplayCorpus } from '../search/replay.mjs';
import PLANS from '../seeds/plans.json' with { type: 'json' };
import { USER_STRINGS } from '../strings.mjs';
import { matchOfficialPrompt } from '../llm/replay-provider.mjs';

function cleanTimezone(value) { return isValidTimezone(value) ? value : config.timezone; }
function safeText(value) { return String(value || '').trim().slice(0, 12_000); }

async function mapConcurrent(items, limit, fn) {
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

function emit(send, type, data) {
  try {
    send(type, data);
  } catch {
    // A disconnected browser must not crash the server.
  }
}
function emitCardsIfChanged(send, cards, last = null) {
  const signature = JSON.stringify(cards || []);
  if (last?.signature === signature) return last;
  emit(send, 'cards', { cards });
  return { signature };
}

function importBaselinePromise({ recall, store, budget, onTiming }) {
  const candidates = (recall.recalled || []).filter((turn) => (
    (turn.origin === 'imported' || turn.claims_status === 'pending') && turn.status === 'completed'
  ));
  if (!candidates.length) return Promise.resolve([]);
  return Promise.all(candidates.map(async (turn) => {
    const existing = store.getClaimsForTurn(turn.id);
    if (existing.length && turn.claims_status === 'done') return existing;
    try {
      const result = await extractAnswerBaseline({ store, turn, budget, plans: PLANS, onTiming });
      return result.claims.length ? result.claims : existing;
    } catch {
      try { store.updateTurn(turn.id, { claims_status: 'failed' }); } catch { /* Ignore if store closed */ }
      return existing;
    }
  })).then((results) => results.flat());
}

function buildEvidenceContext({
  userText,
  recall,
  store,
  turnId,
  claims,
  cards,
  entities,
  timezone,
  sourceExcerpts = new Map(),
  skipFigureCheck = false,
}) {
  const sources = store.getSources(turnId).map((source) => ({
    ...source, excerpt_text: sourceExcerpts.get(source.id) || '',
  }));
  return {
    userText, recalled: recall.recalled || [], claims, cards, sources,
    today: localDateISO(new Date(), timezone), timezone,
    skipFigureCheck,
    entities: entities.map((target) => ({
      name: target.entity,
      key: target.entity_key,
      domain: target.page?.domain || '',
    })),
  };
}

function serialiseSources(store, turnId, sourceTrust, claims = []) {
  return store.getSources(turnId).map((source, index) => ({
    id: source.id, citation_id: `S${index + 1}`, title: source.title, url: source.url,
    domain: source.registrable_domain, trust_label: sourceTrust[source.id] || USER_STRINGS.thirdParty,
    provider_date: source.provider_date, retrieved_at_utc: source.retrieved_at_utc,
    from_cache: Boolean(source.from_cache),
    retrieval_kind: source.retrieval_kind, page_text_origin: source.page_text_origin,
    extraction_status: source.extraction_status,
    page_date_text: source.page_date_text, snippet_text: source.snippet_text,
    evidence_quote: claims.find((claim) => claim.source_id === source.id)?.evidence_quote || null,
  }));
}

function statusText(missing) {
  if (missing.gemini && missing.tavily) return `${userFacing.missingGemini} ${userFacing.missingTavily}`;
  if (missing.gemini) return userFacing.missingGemini;
  if (missing.tavily) return userFacing.missingTavily;
  return 'Ready.';
}

export async function runTurn({
  userText: rawUserText,
  timezone: requestedTimezone,
  store,
  send,
  signal,
  sessionId = null,
}) {
  const started = Date.now();
  const userText = safeText(rawUserText);
  if (!userText) throw new Error('Enter a message first.');
  if (userText.length > 12_000) throw new Error('The message is too long.');
  const timezone = cleanTimezone(requestedTimezone || config.timezone);
  const turn = store.createTurn({ userText, timezone, sessionId });
  const timings = { first_status_ms: Date.now() - started };
  const turnDetails = {
    gemini_calls: [],
    search_calls: [],
    extract_calls: [],
  };
  const onTiming = (item) => {
    if (item?.type === 'stream' || item?.type === 'json') {
      turnDetails.gemini_calls.push(item);
    } else if (item?.type === 'search') {
      turnDetails.search_calls.push(item);
    } else if (item?.type === 'extract') {
      turnDetails.extract_calls.push(item);
    }
  };
  const budget = { searches: 0, extracts: 0, geminiCalls: 0, rounds: 0 };
  emit(send, 'status', { text: 'Checking local history and preparing the request…' });

  const recallStarted = Date.now();
  const recall = recallForTurn({ store, userText, timezone, sessionId });
  if (recall.memory?.length) {
    emit(send, 'memory', { turns: recall.memory });
  }
  const importedBaseline = importBaselinePromise({ recall, store, budget, onTiming });
  timings.memory_ms = Date.now() - recallStarted;
  const modelContext = buildSystemContext({ timezone, recall, store, sessionId });
  const contents = conversationContents(modelContext.contextTurns, userText);
  let systemInstruction = `${SYSTEM_PROMPT}\n\n${modelContext.systemText}`;
  const searchReady = isSearchReady(config);
  const replayActive = Boolean(config.demoMode) || (config.searchBackend === 'replay' && !config.geminiKey);
  const missing = { gemini: !config.geminiKey && !replayActive, tavily: !searchReady };
  if (missing.gemini) {
    store.updateTurn(turn.id, { status: 'failed', claims_status: 'failed', timings_json: timings });
    emit(send, 'error', { message: statusText(missing), code: 'missing_key' });
    emit(send, 'done', { timings: { ...timings, total_ms: Date.now() - started }, budgets: budget });
    return;
  }
  let finalText = '';
  if (replayActive && matchOfficialPrompt(userText) === 0) {
    const fallback =
      'The offline demo only knows the three official prompts. '
      + 'Add GEMINI_API_KEY and TAVILY_API_KEY to try anything else.';
    emit(send, 'token', { text: fallback });
    finalText = fallback;
    store.updateTurn(turn.id, { assistant_text: fallback, status: 'completed', claims_status: 'not_applicable' });
    emit(send, 'done', {
      timings: { ...timings, total_ms: Date.now() - started, effective_model: 'offline-demo' },
      budgets: budget,
    });
    return {
      turnId: turn.id,
      text: fallback,
      recall,
      sources: [],
      cards: [],
      timings: { ...timings, total_ms: Date.now() - started, effective_model: 'offline-demo' },
      budgets: budget,
    };
  }

  const initialStatus = replayActive
    ? 'Offline demo: scripted example answers'
    : (missing.tavily
      ? 'Model ready; web search is not configured.'
      : 'Reasoning about the request…');
  emit(send, 'status', { text: initialStatus });

  let baselinePending = false;

  let extractionPromise = null;
  let currentClaims = [];
  let cards = [];
  let lastEmittedCards = null;
  let activeTargets = [];
  let lastToolPayload = null;
  let errorMessage = null;
  let providerError = null;
  let firstTokenTime = null;
  let firstModelTokenTime = null;
  let sentenceGate = null;
  let directDraft = '';
  let forcedSearch = false;
  let sourceTrust = {};
  const sourceExcerpts = new Map();
  const explicitSince = resolveSinceDate(userText, timezone);
  const searchPolicy = evaluateSearchPolicy(userText);
  const isZeroMatchDateQuery = Boolean(
    recall.resolved?.date
    && (!recall.recalled || recall.recalled.length === 0)
    && /\b(?:what did i (?:ask|say)|did i (?:ask|say)|what was i asking|our conversation|earlier conversation)\b/i
      .test(userText)
  );
  if (isZeroMatchDateQuery) {
    searchPolicy.shouldSearch = false;
  }
  const recallPreface = buildRecallPreface({
    recall,
    timezone,
    willSearch: searchPolicy.shouldSearch,
  });
  if (recallPreface) {
    emit(send, 'token', { text: recallPreface });
    store.appendAssistantText(turn.id, recallPreface);
    if (firstTokenTime === null) {
      firstTokenTime = Date.now() - started;
      timings.first_token_ms = firstTokenTime;
    }
    systemInstruction += '\n\nOpening sentence note: The response opening has already quoted the earlier question'
      + ' and stated the follow-up check. Do not repeat or restate that opening sentence;'
      + ' begin directly with the substantive findings.\n';
  }
  let streamedDirectly = false;

  const contextTurns = modelContext.contextTurns;
  for (let round = 0; round < config.maxToolRounds; round += 1) {
    if (budget.geminiCalls >= config.maxGeminiCalls) {
      errorMessage = 'The per-turn model-call budget was reached. The evidence collected so far is retained.';
      break;
    }
    budget.geminiCalls += 1;
    budget.rounds += 1;
    const roundStart = Date.now();
    const roundStatus = round === 0
      ? 'Asking the model whether web evidence is needed…'
      : 'Checking the collected evidence…';
    emit(send, 'status', { text: roundStatus });
    const isFirstRound = round === 0;
    const roundChunks = [];
    let streamGate = null;
    if (!isFirstRound && lastToolPayload) {
      sentenceGate = sentenceGate || createSentenceGate({
        send, store, turnId: turn.id,
        getContext: () => buildEvidenceContext({
          userText,
          recall,
          store,
          turnId: turn.id,
          claims: currentClaims,
          cards,
          entities: activeTargets,
          timezone,
          sourceExcerpts,
          skipFigureCheck: replayActive,
        }),
        extractionPromise,
      });
      streamGate = sentenceGate;
    }
    let result;
    const canCallTools = round < config.maxToolRounds - 1 && searchPolicy.shouldSearch;
    try {
      result = await generateStream({
        contents, systemInstruction, toolDeclaration: canCallTools ? webSearchDeclaration : null,
        signal,
        recall,
        onStatus: (text) => emit(send, 'status', { text }),
        onRetry: () => { budget.providerRetries = (budget.providerRetries || 0) + 1; },
        onTiming,
        onText: (chunk) => {
          roundChunks.push(chunk);
          if (firstModelTokenTime === null) firstModelTokenTime = Date.now() - started;
          if (streamGate) {
            if (firstTokenTime === null) firstTokenTime = Date.now() - started;
            streamGate.push(chunk);
          } else if (!canCallTools) {
            if (firstTokenTime === null) firstTokenTime = Date.now() - started;
            streamedDirectly = true;
            emit(send, 'token', { text: chunk });
          }
        },
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        if (error.code === 'quota') {
          errorMessage = error.message;
        } else if (error.code === 'missing_key') {
          errorMessage = userFacing.missingGemini;
        } else {
          errorMessage = 'The model provider could not complete this request.';
        }
      } else {
        errorMessage = 'The model request failed. Partial results are available.';
      }
      if (error instanceof ProviderError) {
        providerError = { status: error.status, message: String(error.message || '').slice(0, 200) };
      }
      break;
    }
    timings[`model_round_${round + 1}_ms`] = Date.now() - roundStart;

    if (result.effectiveModel) timings.effective_model = result.effectiveModel;

    if (result.functionCalls.length) {
      roundChunks.length = 0;
      if (sentenceGate && !isFirstRound) {
        sentenceGate = null;
      }
      const functionCall = result.functionCalls.find((call) => call.name === 'web_search');
      if (!functionCall) {
        errorMessage = 'The model requested an unsupported tool. The agent exposes only web_search.';
        break;
      }
      if (!searchReady) {
        const payload = { ok: false, error: userFacing.missingTavily, reason: 'missing_key' };
        contents.push({ role: 'model', parts: result.modelParts || [{ functionCall }] });
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'web_search',
              ...(functionCall.id ? { id: functionCall.id } : {}),
              response: payload,
            },
          }],
        });
        lastToolPayload = payload;
        continue;
      }
      try {
        emit(send, 'status', { text: 'Searching the web and retrieving source pages…' });
        const toolStarted = Date.now();
        const toolPayload = await runWebSearch({
          rawInput: functionCall.args || {}, store, turnId: turn.id, timezone,
          recallTurns: recall.recalled || [], baselineClaimsPromise: importedBaseline,
          explicitSince, budget, signal, plans: PLANS, onTiming,
          ...(config.searchBackend === 'replay' ? {
            searchFn: async ({ q, topic = 'general', since }) => ({
              results: getReplayCorpus().search({ q, topic, since, limit: 5 }),
            }),
            extractFn: async (url) => {
              const page = getReplayCorpus().extract(url);
              const results = page ? [{
                url: page.url,
                title: page.title,
                raw_content: page.raw_content,
              }] : [];
              return { results };
            },
          } : {}),
        });
        timings.search_ms = (timings.search_ms || 0) + (Date.now() - toolStarted);
        lastToolPayload = toolPayload;
        for (const source of toolPayload.sources || []) {
          if (source.source_id && source.excerpt) sourceExcerpts.set(source.source_id, source.excerpt);
        }
        for (const target of toolPayload.targets || []) {
          if (target.page?.source_id && target.page.excerpt) {
            sourceExcerpts.set(target.page.source_id, target.page.excerpt);
          }
        }
        if (toolPayload.provider_errors?.length) {
          const hasAnyEvidence = (toolPayload.sources?.length || 0) > 0
            || (toolPayload.targets || []).some((t) => t.page?.source_id || (t.news || []).length > 0);
          if (!hasAnyEvidence) {
            const firstFailure = toolPayload.provider_errors[0];
            emit(send, 'error', {
              message: 'Web search requests failed.',
              status: firstFailure.status, provider_message: firstFailure.message,
            });
          }
        }
        sourceTrust = toolPayload.sourceTrust || {};
        activeTargets = toolPayload.targets || [];
        baselinePending = baselinePending || Boolean(toolPayload.baseline_pending);
        const pageSourceItems = new Map();
        const targetSourceIds = new Set();
        for (const target of activeTargets) {
          for (const item of [target.page, ...(target.news || [])]) {
            if (!item?.source_id) continue;
            const source = store.getSource(item.source_id);
            if (source?.page_text) {
              targetSourceIds.add(source.id);
              pageSourceItems.set(source.id, { source, entity: target.entity });
            }
          }
        }
        const unassignedPages = store.getSources(turn.id).filter((row) => (
          row.retrieval_kind === 'page_text' && !targetSourceIds.has(row.id)
        ));
        for (const source of unassignedPages) {
          pageSourceItems.set(source.id, { source, entity: '' });
        }
        const pageSources = [...pageSourceItems.values()];
        if (pageSources.length) {
          const beforeClaims = Date.now();
          const extractionWork = async () => {
            await importedBaseline;
            if (config.extractionMode === 'per_entity') {
              const cardByEntity = new Map();
              let targetClaims = [];

              const outcomes = await mapConcurrent(activeTargets, 2, async (target) => {
                const sources = pageSources.filter((item) => item.entity === target.entity);
                let entityClaims = [];
                if (sources.length) {
                  try {
                    const outcome = await extractPageClaims({
                      store, turnId: turn.id, sourceItems: sources, budget,
                      entityFilter: target.entity_key, plans: PLANS, onTiming,
                    });
                    if (outcome.wrongPageSourceIds?.includes(target.page?.source_id)) {
                      target.page.extraction_reason = 'wrong_page';
                    }
                    entityClaims = outcome.claims;
                  } catch {
                    entityClaims = [];
                  }
                }
                const historical = store.getClaimsForEntities([target.entity_key], turn.id);
                const oneCard = buildComparisonCards({
                  store, targets: [target], currentClaims: entityClaims,
                  baselineClaims: historical, plans: PLANS,
                  sinceByEntity: { [target.entity_key]: target.since },
                })[0];
                cardByEntity.set(target.entity_key, oneCard);
                const resolvedCards = activeTargets.filter((item) => cardByEntity.has(item.entity_key))
                  .map((item) => cardByEntity.get(item.entity_key));
                lastEmittedCards = emitCardsIfChanged(send, resolvedCards, lastEmittedCards);
                return entityClaims;
              });
              targetClaims = outcomes.flat();

              const nonTargetSources = pageSources.filter((item) => !item.entity);
              if (nonTargetSources.length) {
                const requiredCalls = claimExtractionBatchCount(nonTargetSources);
                if (budget.geminiCalls + requiredCalls > config.maxGeminiCalls) {
                  timings.extraction_skipped_budget = true;
                } else {
                  try {
                    const result = await extractPageClaims({
                      store, turnId: turn.id, sourceItems: nonTargetSources, budget, plans: PLANS, onTiming,
                    });
                    targetClaims.push(...result.claims);
                  } catch {}
                }
              }
              return targetClaims;
            }
            const outcome = await extractPageClaims({
              store, turnId: turn.id, sourceItems: pageSources, budget, plans: PLANS, onTiming,
            });
            for (const target of activeTargets) {
              if (outcome.wrongPageSourceIds?.includes(target.page?.source_id)) {
                target.page.extraction_reason = 'wrong_page';
              }
            }
            return outcome.claims;
          };
          extractionPromise = extractionWork().then((claims) => {
            currentClaims = claims;
            store.updateTurn(turn.id, { claims_status: 'done' });
            timings.extraction_ms = Date.now() - beforeClaims;
            return claims;
          }).catch((error) => {
            try { store.updateTurn(turn.id, { claims_status: 'failed' }); } catch {}
            return [];
          });
        } else {
          extractionPromise = Promise.resolve([]);
          store.updateTurn(turn.id, { claims_status: 'done' });
        }
        if (activeTargets.length) {
          if (baselinePending) {
            cards = activeTargets.map((target) => ({
              entity: target.entity,
              entity_key: target.entity_key,
              cards: target.checks.map((check) => ({
                entity: target.entity,
                attribute: check,
                status: USER_STRINGS.couldntConfirm,
                reason: 'baseline_pending',
                domain: target.page?.domain || null,
              })),
            }));
          } else {
            // Resolve every entity status before the model writes its commentary.
            await importedBaseline;
            try { currentClaims = await extractionPromise; } catch { currentClaims = []; }
            const historical = store.getClaimsForEntities(activeTargets.map((target) => target.entity_key), turn.id);
            cards = buildComparisonCards({
              store, targets: activeTargets, currentClaims, baselineClaims: historical,
              plans: PLANS,
              sinceByEntity: Object.fromEntries(activeTargets.map((target) => [target.entity_key, target.since])),
            });
            lastEmittedCards = emitCardsIfChanged(send, cards, lastEmittedCards);
          }
        }
        emit(send, 'sources', { sources: serialiseSources(store, turn.id, sourceTrust, currentClaims) });
        contents.push({ role: 'model', parts: result.modelParts || [{ functionCall }] });
        const response = {
          ...toolPayload,
          cards,
          comparison_rule: 'Statuses in cards are code-assigned and final. Do not change them.',
        };
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'web_search',
              ...(functionCall.id ? { id: functionCall.id } : {}),
              response,
            },
          }],
        });
      } catch (error) {
        const payload = {
          ok: false,
          error: error instanceof ToolInputError
            ? error.message
            : 'Web search failed or its per-turn budget was reached.',
          reason: error.code || 'search_error',
        };
        contents.push({ role: 'model', parts: result.modelParts || [{ functionCall }] });
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: 'web_search',
              ...(functionCall.id ? { id: functionCall.id } : {}),
              response: payload,
            },
          }],
        });
        lastToolPayload = payload;
      }
      continue;
    }

    if (streamGate && canCallTools && !firstTokenTime) {
      for (const chunk of roundChunks) {
        if (firstTokenTime === null) firstTokenTime = Date.now() - started;
        streamGate.push(chunk);
      }
    }

    if (isFirstRound) {
      const scannerStart = Date.now();
      directDraft = result.text.trim();
      if (hasMutableFactSignal(directDraft, { userText }) && searchReady) {
        timings.scanner_buffering_ms = (timings.scanner_buffering_ms || 0) + (Date.now() - scannerStart);
        forcedSearch = true;
        contents.push({ role: 'model', parts: result.modelParts || [{ text: directDraft }] });
        const instruction = [
          'Your buffered draft includes a potentially mutable fact. Search before answering. ',
          'Call web_search for the relevant claims, and do not provide a final answer ',
          'until evidence has been checked.',
        ].join('');
        contents.push({ role: 'user', parts: [{ text: instruction }] });
        continue;
      }
      if (hasMutableFactSignal(directDraft, { userText }) && !searchReady) {
        const unavailableNote = `${userFacing.searchUnavailable} `
          + 'This comes from general knowledge and was not checked today.';
        directDraft += `\n\n${unavailableNote}`;
      }
      const context = buildEvidenceContext({
        userText,
        recall,
        store,
        turnId: turn.id,
        claims: [],
        cards: [],
        entities: [],
        timezone,
        sourceExcerpts,
        skipFigureCheck: replayActive,
      });
      const checked = checkAnswerFigures(directDraft, context);
      timings.scanner_buffering_ms = (timings.scanner_buffering_ms || 0) + (Date.now() - scannerStart);
      finalText = checked.text;
      if (finalText) {
        if (firstModelTokenTime === null) firstModelTokenTime = Date.now() - started;
        if (firstTokenTime === null) firstTokenTime = Date.now() - started;
        store.appendAssistantText(turn.id, finalText);
        if (!streamedDirectly) {
          emit(send, 'token', { text: finalText });
        }
      }
      for (const marker of checked.markers) emit(send, 'figure_marker', marker);
      break;
    }

    if (sentenceGate) {
      await sentenceGate.flush();
      sentenceGate = null;
    }
    finalText = store.getTurn(turn.id)?.assistant_text || '';
    if (!finalText && result.text.trim()) {
      const context = buildEvidenceContext({
        userText,
        recall,
        store,
        turnId: turn.id,
        claims: currentClaims,
        cards,
        entities: activeTargets,
        timezone,
        sourceExcerpts,
        skipFigureCheck: replayActive,
      });
      const checked = checkAnswerFigures(result.text, context);
      finalText = checked.text;
      store.appendAssistantText(turn.id, finalText);
      emit(send, 'token', { text: finalText });
      for (const marker of checked.markers) emit(send, 'figure_marker', marker);
    }
    break;
  }

  if (extractionPromise) {
    try { currentClaims = await extractionPromise; }
    catch { store.updateTurn(turn.id, { claims_status: 'failed' }); }
  }
  if (sentenceGate) {
    try { await sentenceGate.flush(); } catch { /* The generated partial answer remains stored. */ }
  }
  const storedTurn = store.getTurn(turn.id);
  finalText = storedTurn?.assistant_text || finalText;
  if (!finalText && errorMessage) {
    finalText = errorMessage;
    emit(send, 'token', { text: finalText });
  }
  if (!finalText && !errorMessage) {
    finalText = 'I could not produce a verified answer from the available evidence.';
    store.appendAssistantText(turn.id, finalText);
    emit(send, 'token', { text: finalText });
  }
  if (activeTargets.length && !cards.length) {
    const historical = store.getClaimsForEntities(activeTargets.map((target) => target.entity_key), turn.id);
    const sinceByEntity = Object.fromEntries(
      activeTargets.map((target) => [target.entity_key, target.since]),
    );
    cards = buildComparisonCards({
      store,
      targets: activeTargets,
      currentClaims,
      baselineClaims: historical,
      plans: PLANS,
      sinceByEntity,
    });
    lastEmittedCards = emitCardsIfChanged(send, cards, lastEmittedCards);
  }
  if (!activeTargets.length && !cards.length) {
    const baselineClaims = await importedBaseline;
    const recalledKeys = [...new Set((baselineClaims || []).map((c) => c.entity_key).filter(Boolean))];
    const isCheckTurn = /\b(?:changed|pricing|shipped|since|still correct|shortlisted|compare|cost|hosting)\b/i
      .test(userText);
    if (recalledKeys.length > 0 && isCheckTurn) {
      const CANONICAL = {
        hubspot: 'HubSpot', pipedrive: 'Pipedrive', zoho: 'Zoho', monday: 'Monday',
        freshsales: 'Freshsales', neon: 'Neon', supabase: 'Supabase', aws: 'AWS RDS',
      };
      const sources = store.getSources(turn.id);
      activeTargets = recalledKeys.map((key) => {
        const entity = CANONICAL[key] || (key.charAt(0).toUpperCase() + key.slice(1));
        const matchingSource = sources.find((s) => (
          s.url && (s.url.toLowerCase().includes(key)
            || trustLabel(entity, s.url, PLANS).label !== USER_STRINGS.thirdParty)
        ));
        return {
          entity,
          entity_key: key,
          checks: ['pricing', 'news'],
          since: explicitSince || null,
          page: matchingSource ? {
            source_id: matchingSource.id,
            title: matchingSource.title,
            url: matchingSource.url,
            domain: matchingSource.registrable_domain,
            trust: trustLabel(entity, matchingSource.url, PLANS).label,
            page_date_text: matchingSource.page_date_text,
            excerpt: matchingSource.page_text ? matchingSource.page_text.slice(0, 500) : '',
          } : null,
          news: [],
        };
      });
      const historical = store.getClaimsForEntities(activeTargets.map((target) => target.entity_key), turn.id);
      const sinceByEntity = Object.fromEntries(
        activeTargets.map((target) => [target.entity_key, target.since]),
      );
      cards = buildComparisonCards({
        store,
        targets: activeTargets,
        currentClaims,
        baselineClaims: historical,
        plans: PLANS,
        sinceByEntity,
      });
      lastEmittedCards = emitCardsIfChanged(send, cards, lastEmittedCards);
    }
  }

  // Enforce design rule: "no evidence" never means "no change".
  if (cards.length) {
    const unconfirmedEntities = [];
    for (const group of cards) {
      const allConfirmedSame = (group.cards || []).length > 0
        && (group.cards || []).every((c) => c.status === USER_STRINGS.sameAsBefore);
      if (!allConfirmedSame) {
        unconfirmedEntities.push(group.entity);
      }
    }
    for (const name of unconfirmedEntities) {
      const unconfirmedPattern = new RegExp(
        String.raw`\bno\s+pricing\s+changes?\s+(?:have\s+been\s+reported\s+)?(?:for\s+)?${name}\b`,
        'gi',
      );
      if (unconfirmedPattern.test(finalText)) {
        finalText = finalText.replace(
          unconfirmedPattern,
          `pricing for ${name} could not be confirmed from official sources`,
        );
        store.updateTurn(turn.id, { assistant_text: finalText });
      }
      const generalUnconfirmedPattern = new RegExp(
        String.raw`\bno\s+pricing\s+changes?\s+have\s+been\s+reported\s+for\s+`
        + String.raw`(?:Neon\s+or\s+Supabase|Supabase\s+or\s+Neon)\b`,
        'gi',
      );
      if (generalUnconfirmedPattern.test(finalText)) {
        finalText = finalText.replace(
          generalUnconfirmedPattern,
          'pricing could not be confirmed from official sources for Neon or Supabase',
        );
        store.updateTurn(turn.id, { assistant_text: finalText });
      }
    }
  }
  const sources = serialiseSources(store, turn.id, sourceTrust, currentClaims);
  timings.first_token_ms = firstTokenTime ?? null;
  timings.first_model_token_ms = firstModelTokenTime ?? null;
  timings.scanner_buffering_ms = timings.scanner_buffering_ms || 0;
  timings.gemini_calls = turnDetails.gemini_calls;
  timings.gemini_backoff_ms = turnDetails.gemini_calls.reduce((sum, c) => sum + (c.backoff_wait_ms || 0), 0);
  timings.gemini_throttle_ms = turnDetails.gemini_calls.reduce((sum, c) => sum + (c.throttle_wait_ms || 0), 0);
  timings.gemini_duration_ms = turnDetails.gemini_calls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);
  timings.search_calls = turnDetails.search_calls;
  timings.extract_calls = turnDetails.extract_calls;
  timings.provider_retries = budget.providerRetries || 0;
  timings.total_ms = Date.now() - started;
  const latestTurn = store.getTurn(turn.id);
  const finalTurnStatus = signal?.aborted
    ? 'interrupted'
    : errorMessage && !storedTurn?.assistant_text ? 'failed' : 'completed';
  const finalClaimsStatus = latestTurn?.claims_status === 'pending'
    ? currentClaims.length || !errorMessage ? 'done' : 'failed'
    : latestTurn?.claims_status;
  store.updateTurn(turn.id, {
    status: finalTurnStatus,
    claims_status: finalClaimsStatus,
    timings_json: timings,
  });
  emit(send, 'sources', { sources });
  emit(send, 'timings', {
    timings,
    budgets: {
      ...budget,
      searches_remaining: config.maxSearches - budget.searches,
      extracts_remaining: config.maxExtracts - budget.extracts,
      gemini_calls_remaining: config.maxGeminiCalls - budget.geminiCalls,
    },
    forced_search: forcedSearch,
  });
  if (errorMessage) {
    emit(send, 'error', {
      message: errorMessage,
      code: 'partial_failure',
      status: providerError?.status || 0,
      provider_message: providerError?.message || null,
    });
  }
  emit(send, 'done', { turn_id: turn.id, status: finalTurnStatus, timings, budgets: budget });
  return { turnId: turn.id, text: finalText, recall, sources, cards, timings, budgets: budget };
}
