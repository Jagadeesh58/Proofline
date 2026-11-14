import { parseMarkdown } from './markdown.mjs';
import { mergeCardsByEntity } from './card-state.mjs';

const $ = (selector) => document.querySelector(selector);
const messages = $('#messages');
const input = $('#messageInput');
const form = $('#chatForm');
const workingLine = $('#workingLine');
const workingText = $('#workingText');
const stopButton = $('#stopButton');
const sendButton = $('#sendButton');
const providerBanner = $('#providerBanner');
const historyList = $('#historyList');
const memoryRegion = $('#memoryRegion');
const cardsRegion = $('#cardsRegion');
const sourcesRegion = $('#sourcesRegion');
const serverNotice = $('#serverNotice');
let healthPollInterval = null;
let activeController = null;
let currentAssistantBubble = null;
let sourceMap = new Map();
let currentExtrasRegion = null;
let renderedCardGroups = [];
let cardGroupNodes = new Map();
let cardGroupSignatures = new Map();
let cardsSection = null;
let turnFigureMarkers = [];
let figureDetails = null;

function setWorking(active, text = 'Ready when you are.') {
  workingLine.classList.toggle('active', active);
  workingText.textContent = text;
  stopButton.classList.toggle('hidden', !active);
  sendButton.disabled = active;
  $('#statusIndicator').lastChild.textContent = active ? ' Working' : ' Ready';
}

function setServerNotice(message = '', isError = false, showSpinner = false) {
  if (!serverNotice) return;
  if (!message) {
    serverNotice.classList.add('hidden');
    serverNotice.replaceChildren();
    return;
  }
  serverNotice.classList.remove('hidden');
  serverNotice.classList.toggle('error', isError);
  serverNotice.replaceChildren();
  if (showSpinner) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    serverNotice.append(spinner);
  }
  const text = document.createElement('span');
  text.textContent = message;
  serverNotice.append(text);
}

async function checkServerHealth() {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      const data = await res.json();
      if (data.status === 'ok' || data.ok) {
        setServerNotice('');
        if (healthPollInterval) {
          clearInterval(healthPollInterval);
          healthPollInterval = null;
        }
        return true;
      }
    }
  } catch { /* Server remains unreachable. */ }
  return false;
}

function startColdStartPolling(reason = 'waking') {
  if (healthPollInterval) return;
  const msg = reason === 'connection'
    ? 'Connection lost. Checking server health and reconnecting…'
    : 'Server is waking up (cold start can take 30–50s on free hosts). Waiting for health check…';
  setServerNotice(msg, reason === 'connection', true);
  const statusIndicator = $('#statusIndicator');
  if (statusIndicator?.lastChild) statusIndicator.lastChild.textContent = ' Connecting';

  healthPollInterval = setInterval(async () => {
    const alive = await checkServerHealth();
    if (alive) {
      if (statusIndicator?.lastChild) statusIndicator.lastChild.textContent = ' Ready';
      await loadConfig();
      await loadHistory();
    }
  }, 4000);
}

function addMessage(role, text) {
  $('#welcome').classList.add('hidden');
  const wrapper = document.createElement('article');
  wrapper.className = `message ${role}`;
  if (role === 'assistant') {
    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = 'RESEARCH AGENT';
    wrapper.append(label);
  }
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text || '';
  wrapper.append(bubble);
  const extras = document.createElement('div');
  extras.className = 'message-extras';
  wrapper.append(extras);
  if (role === 'assistant') {
    const copy = document.createElement('button');
    copy.className = 'copy-answer';
    copy.type = 'button';
    copy.textContent = 'Copy answer';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(bubble.textContent || '');
        copy.textContent = 'Copied';
      } catch { copy.textContent = 'Copy unavailable'; }
      window.setTimeout(() => { copy.textContent = 'Copy answer'; }, 1600);
    });
    wrapper.append(copy);
  }
  messages.append(wrapper);
  if (role === 'assistant') currentExtrasRegion = extras;
  scrollToBottom();
  return bubble;
}

function scrollToBottom() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }

function appendInline(parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') parent.append(document.createTextNode(token.value));
    else if (token.type === 'bold' || token.type === 'code') {
      const element = document.createElement(token.type === 'bold' ? 'strong' : 'code');
      element.textContent = token.value;
      parent.append(element);
    } else if (token.type === 'link') {
      const link = document.createElement('a');
      link.href = token.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = token.value;
      parent.append(link);
    } else if (token.type === 'citation') {
      const source = sourceMap.get(token.value.slice(1, -1));
      if (source && /^https?:\/\//i.test(source.url)) {
        const link = document.createElement('a');
        link.href = source.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'citation-link';
        link.textContent = token.value;
        parent.append(link);
      } else parent.append(document.createTextNode(token.value));
    }
  }
}

function renderMarkdown(bubble, text) {
  bubble.replaceChildren();
  for (const block of parseMarkdown(text)) {
    if (block.type === 'code-block') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.value;
      pre.append(code);
      bubble.append(pre);
    } else if (block.type === 'ul' || block.type === 'ol') {
      const list = document.createElement(block.type === 'ul' ? 'ul' : 'ol');
      for (const item of block.items) {
        const li = document.createElement('li');
        appendInline(li, item);
        list.append(li);
      }
      bubble.append(list);
    } else {
      const paragraph = document.createElement('p');
      appendInline(paragraph, block.tokens);
      bubble.append(paragraph);
    }
  }
}

function renderMemory(turns) {
  memoryRegion.replaceChildren();
  for (const turn of turns || []) {
    const card = document.createElement('div');
    card.className = 'memory-card';
    const label = document.createElement('div');
    label.className = 'memory-label';
    label.textContent = 'RECALLED FROM YOUR HISTORY';
    const question = document.createElement('div');
    question.className = 'memory-question';
    question.textContent = `“${turn.question || '(question text was not imported)'}”`;
    const meta = document.createElement('div');
    meta.className = 'memory-meta';
    const originSuffix = turn.originally_generated_label
      ? ` · ${turn.originally_generated_label}`
      : (turn.generation_date_unknown_label ? ` · ${turn.generation_date_unknown_label}` : '');
    meta.textContent = `You asked on ${turn.displayed_at}${originSuffix}`;
    card.append(label, question, meta);
    memoryRegion.append(card);
  }
  scrollToBottom();
}

const REASON_LABELS = {
  baseline_pending: 'Earlier data is still being processed',
  stale_page: 'This page is older than the saved baseline',
  terms_unknown: 'Billing terms could not be confirmed',
  different_source_sites: 'The sources refer to different websites',
  third_party_source: 'This information comes from a third-party website',
  no_results: 'No matching results were found',
  extraction_failed: 'Page information could not be extracted',
  wrong_page: 'This page does not match the requested product',
  unspecified_plan: 'Plan name was not specified in source',
  currency_mismatch: 'Different currencies cannot be compared directly',
  ambiguous_dollar: 'Currency is an ambiguous dollar symbol',
};

function formatReason(reason) {
  if (!reason) return '';
  return REASON_LABELS[reason] || reason.replaceAll('_', ' ');
}

function resetCards() {
  cardsRegion.replaceChildren();
  renderedCardGroups = [];
  cardGroupNodes = new Map();
  cardGroupSignatures = new Map();
  cardsSection = null;
}

function renderCards(cards) {
  renderedCardGroups = mergeCardsByEntity(renderedCardGroups, cards || []);
  if (!renderedCardGroups.length) return;
  if (!cardsSection) {
    cardsSection = document.createElement('div');
    cardsSection.className = 'cards-wrap';
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Comparison results';
    cardsSection.append(label);
    cardsRegion.append(cardsSection);
  }
  let changed = false;
  for (const entity of renderedCardGroups) {
    const key = String(entity.entity_key || entity.entity || '').trim().toLocaleLowerCase('en-GB');
    const signature = JSON.stringify(entity);
    if (cardGroupSignatures.get(key) === signature) continue;
    let groupNode = cardGroupNodes.get(key);
    if (!groupNode) {
      groupNode = document.createElement('div');
      groupNode.className = 'comparison-entity-group';
      cardGroupNodes.set(key, groupNode);
      cardsSection.append(groupNode);
    } else {
      groupNode.replaceChildren();
    }
    for (const item of entity.cards || []) {
      const card = document.createElement('div');
      card.className = 'comparison-card';
      const head = document.createElement('div');
      head.className = 'comparison-head';
      const name = document.createElement('div');
      name.className = 'comparison-name';
      name.textContent = `${item.entity} · ${item.attribute}${item.plan ? ` · ${item.plan}` : ''}`;
      const status = document.createElement('div');
      status.className = 'comparison-status';
      status.textContent = item.status;
      head.append(name, status);
      card.append(head);
      const meta = document.createElement('div');
      meta.className = 'comparison-meta';
      const dateContext = entity.explicit_since && entity.baseline_since
        && entity.explicit_since !== entity.baseline_since
        ? `Requested since ${entity.explicit_since}; baseline from ${entity.baseline_since}` : '';
      const reasonLabel = formatReason(item.reason);
      meta.textContent = [item.domain, item.trust_label, reasonLabel ? `Reason: ${reasonLabel}` : '', dateContext]
        .filter(Boolean).join(' · ');
      card.append(meta);
      if (item.current || item.baseline) {
        const values = document.createElement('div');
        values.className = 'comparison-values';
        for (const [title, value] of [['CURRENT', item.current], ['BASELINE', item.baseline]]) {
          const col = document.createElement('div');
          const h = document.createElement('div');
          h.className = 'value-label';
          h.textContent = title;
          col.append(h);
          const v = document.createElement('div');
          v.className = 'value-text';
          v.textContent = value?.value || 'No earlier value';
          col.append(v);
          if (value?.quote) {
            const q = document.createElement('div');
            q.className = 'quote';
            q.textContent = `“${value.quote}”`;
            col.append(q);
          }
          values.append(col);
        }
        card.append(values);
      }
      if (entity.reported?.length) {
        const news = document.createElement('div');
        news.className = 'comparison-meta';
        const newsItems = entity.reported.map((item) => `${item.date} — ${item.title}`).join('; ');
        news.textContent = `${entity.reported_since_label}: ${newsItems}`;
        card.append(news);
      }
      groupNode.append(card);
    }
    cardGroupSignatures.set(key, signature);
    changed = true;
  }
  if (changed) scrollToBottom();
}

function renderFigureMarkerDetails() {
  if (!turnFigureMarkers.length || !currentExtrasRegion) return;
  if (!figureDetails) {
    figureDetails = document.createElement('details');
    figureDetails.className = 'turn-details figure-marker-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Evidence checks';
    figureDetails.append(summary);
    currentExtrasRegion.append(figureDetails);
  }
  const summary = figureDetails.querySelector('summary');
  figureDetails.replaceChildren(summary);
  for (const marker of turnFigureMarkers) {
    const row = document.createElement('p');
    row.textContent = marker;
    figureDetails.append(row);
  }
}

function resetFigureMarkers() {
  turnFigureMarkers = [];
  figureDetails = null;
}

function renderSources(sources) {
  sourceMap = new Map((sources || []).map((source) => [source.citation_id, source]));
  sourcesRegion.replaceChildren();
  if (!sources?.length) return;
  const section = document.createElement('div');
  section.className = 'sources-wrap';
  const label = document.createElement('div');
  label.className = 'section-label';
  label.textContent = 'SOURCES · RETRIEVED THIS TURN';
  section.append(label);
  for (const source of sources) {
    if (!/^https?:\/\//i.test(source.url)) continue;
    const link = document.createElement('a');
    link.className = 'source-chip';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const id = document.createElement('strong');
    id.textContent = source.citation_id;
    const title = document.createElement('span');
    title.textContent = source.title || source.domain;
    link.append(id, title);
    section.append(link);
    const detail = document.createElement('div');
    detail.className = 'source-detail';
    const extractionStatus = source.extraction_status && source.extraction_status !== 'ok'
      ? ` · extraction: ${source.extraction_status}` : '';
    const dateDesc = source.page_date_text ? ` · page date: ${source.page_date_text}` : ' · page shows no date';
    const domainDesc = source.domain || 'unknown domain';
    const trustDesc = source.trust_label || source.retrieval_kind || 'source';
    const retrievedDesc = source.retrieved_at_utc ? ` · retrieved ${source.retrieved_at_utc}` : '';
    detail.textContent = `${domainDesc} · ${trustDesc}${retrievedDesc}${dateDesc}${extractionStatus}`;
    section.append(detail);
    const disclosure = document.createElement('details');
    disclosure.className = 'source-evidence';
    const originDesc = source.retrieval_kind === 'page_text'
      ? `page text via ${source.page_text_origin || 'provider'}`
      : 'search snippet';
    const summary = document.createElement('summary');
    summary.textContent = `Evidence details · ${originDesc}`;
    disclosure.append(summary);
    const evidence = document.createElement('p');
    evidence.textContent = source.evidence_quote
      ? `Validated quote: “${source.evidence_quote}”`
      : (source.snippet_text || 'No excerpt is available.');
    disclosure.append(evidence);
    section.append(disclosure);
  }
  sourcesRegion.append(section);
  scrollToBottom();
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    setServerNotice('');
    $('#modelChip').textContent = data.model;
    $('#timezoneLabel').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || data.timezone;
    providerBanner.replaceChildren();
    if (data.messages?.length) {
      providerBanner.classList.remove('hidden');
      for (const message of data.messages) {
        const p = document.createElement('p');
        p.textContent = message;
        providerBanner.append(p);
      }
    } else {
      providerBanner.classList.add('hidden');
    }
  } catch {
    providerBanner.textContent = 'The server is not currently reachable.';
    providerBanner.classList.remove('hidden');
    startColdStartPolling('waking');
  }
}

async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    historyList.replaceChildren();
    const turns = data.turns || [];
    const emptyAction = $('#emptyDemoAction');
    if (turns.length === 0) {
      emptyAction?.classList.remove('hidden');
      const emptyNote = document.createElement('div');
      emptyNote.className = 'history-empty-hint';
      emptyNote.textContent = 'No previous conversations in this session.';
      historyList.append(emptyNote);
    } else {
      emptyAction?.classList.add('hidden');
      for (const turn of turns) {
        const button = document.createElement('button');
        button.className = 'history-item';
        const titleText = turn.user_text || '(imported turn without a question)';
        button.textContent = `${turn.is_demo ? 'DEMO · ' : ''}${titleText}`;
        button.title = `${turn.local_date} · ${turn.origin}`;
        button.addEventListener('click', () => {
          messages.replaceChildren();
          memoryRegion.replaceChildren();
          resetCards();
          sourcesRegion.replaceChildren();
          resetFigureMarkers();
          addMessage('user', turn.user_text || '');
          const bubble = addMessage('assistant', '');
          renderMarkdown(bubble, turn.assistant_text || '');
        });
        historyList.append(button);
      }
    }
  } catch { /* The banner and empty history are enough when the server is unavailable. */ }
}

async function consumeEventStream(response, onEvent) {
  if (!response.ok || !response.body) {
    let msg = 'The server could not start this request.';
    try {
      const err = await response.json();
      if (err?.error || err?.message) msg = err.error || err.message;
    } catch {
      try {
        const text = await response.text();
        if (text) msg = text;
      } catch { /* Ignore stream reading errors. */ }
    }
    throw new Error(msg);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) {
        try { onEvent(event, JSON.parse(data)); }
        catch { /* Ignore a malformed event without breaking the stream. */ }
      }
      index = buffer.indexOf('\n\n');
    }
  }
}

async function sendMessage(message) {
  const userBubble = addMessage('user', message);
  const assistantBubble = addMessage('assistant', '');
  currentAssistantBubble = assistantBubble;
  memoryRegion.replaceChildren();
  resetCards();
  sourcesRegion.replaceChildren();
  sourceMap.clear();
  resetFigureMarkers();
  setWorking(true, 'Preparing the request…');
  activeController = new AbortController();
  let assistantText = '';
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata' }),
      signal: activeController.signal,
    });
    await consumeEventStream(response, (event, data) => {
      if (event === 'status') {
        setWorking(true, data.text);
        if (data.text?.includes('rate limit') || data.text?.includes('fallback')) {
          providerBanner.textContent = data.text;
          providerBanner.classList.remove('hidden');
        }
      }
      if (event === 'memory') renderMemory(data.turns);
      if (event === 'token') {
        assistantText += data.text;
        renderMarkdown(assistantBubble, assistantText);
        scrollToBottom();
      }
      if (event === 'cards') renderCards(data.cards);
      if (event === 'sources') {
        renderSources(data.sources);
        renderMarkdown(assistantBubble, assistantText);
      }
      if (event === 'timings') {
        const values = data.timings || {};
        const timingLine = document.createElement('div');
        timingLine.className = 'timing-line';
        const ttftStr = values.first_token_ms != null ? `${values.first_token_ms} ms` : '—';
        const totalStr = values.total_ms != null ? `${values.total_ms} ms` : '—';
        const modelStr = values.effective_model ? ` · ${values.effective_model}` : '';
        timingLine.textContent = `⏱ First token: ${ttftStr} · Total: ${totalStr}${modelStr}`;
        currentExtrasRegion?.append(timingLine);

        const parts = [
          ...(values.effective_model ? [`model ${values.effective_model}`] : []),
          `total ${values.total_ms ?? '—'} ms`,
          `first token ${values.first_token_ms ?? '—'} ms`,
          `searches ${data.budgets?.searches ?? 0}`,
          `extracts ${data.budgets?.extracts ?? 0}`,
          `Gemini calls ${data.budgets?.geminiCalls ?? 0}`,
          `provider retries ${values.provider_retries ?? 0}`,
          ...(values.extraction_skipped_budget ? ['non-target extraction skipped: budget'] : []),
        ];
        const footer = document.createElement('details');
        footer.className = 'turn-details';
        const summary = document.createElement('summary');
        summary.textContent = parts.join(' · ');
        footer.append(summary);
        const body = document.createElement('pre');
        body.textContent = JSON.stringify(
          { timings: values, budgets: data.budgets || {}, forced_search: data.forced_search || false },
          null,
          2
        );
        footer.append(body);
        renderFigureMarkerDetails();
        currentExtrasRegion?.append(footer);
      }
      if (event === 'figure_marker') {
        const markerText = `${data.marker || ''} · ${data.sentence || ''}`;
        turnFigureMarkers.push(markerText);
        renderFigureMarkerDetails();
        const note = document.createElement('div');
        note.className = 'figure-warning';
        note.textContent = markerText;
        currentExtrasRegion?.append(note);
      }
      if (event === 'error') {
        if (!assistantText) { assistantText = data.message; renderMarkdown(assistantBubble, assistantText); }
        const detail = document.createElement('details');
        detail.className = 'turn-details';
        const summary = document.createElement('summary');
        summary.textContent = data.status ? `Provider error · HTTP ${data.status}` : 'Request details';
        detail.append(summary);
        const explanation = document.createElement('p');
        explanation.textContent = data.provider_message || data.message;
        detail.append(explanation);
        currentExtrasRegion?.append(detail);
      }
    });
  } catch (error) {
    if (error.name !== 'AbortError') {
      assistantBubble.textContent = error.message || 'The request failed.';
      if (error instanceof TypeError || error.message?.includes('fetch')) {
        startColdStartPolling('connection');
      }
    }
  } finally {
    activeController = null;
    currentAssistantBubble = null;
    currentExtrasRegion = null;
    setWorking(false);
    loadHistory();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || activeController) return;
  input.value = '';
  input.style.height = 'auto';
  sendMessage(message);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
stopButton.addEventListener('click', () => activeController?.abort());
$('#newChat').addEventListener('click', () => {
  messages.replaceChildren();
  memoryRegion.replaceChildren();
  resetCards();
  sourcesRegion.replaceChildren();
  resetFigureMarkers();
  currentAssistantBubble = null;
  currentExtrasRegion = null;
  sourceMap.clear();
  $('#welcome').classList.remove('hidden');
  input.focus();
});
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});
async function triggerDemoHistory() {
  const buttons = [$('#demoHistory'), $('#welcomeDemoHistory')].filter(Boolean);
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const response = await fetch('/api/demo-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const data = await response.json();
    workingText.textContent = data.message || data.error;
    await loadHistory();
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}
$('#demoHistory')?.addEventListener('click', triggerDemoHistory);
$('#welcomeDemoHistory')?.addEventListener('click', triggerDemoHistory);
$('#importToggle').addEventListener('click', () => $('#importPanel').classList.toggle('hidden'));
$('#closeImport').addEventListener('click', () => $('#importPanel').classList.add('hidden'));
$('#importButton').addEventListener('click', async () => {
  const target = $('#importMessage');
  target.textContent = 'Importing…';
  try {
    const parsed = JSON.parse($('#importJson').value);
    const response = await fetch('/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed),
    });
    const result = await response.json();
    target.textContent = response.ok ? result.message : result.error;
    if (response.ok) {
      await loadHistory();
      $('#importPanel').classList.add('hidden');
    }
  } catch (error) {
    target.textContent = error instanceof SyntaxError ? 'The JSON is not valid.' : error.message;
  }
});

loadConfig();
loadHistory();
input.focus();
