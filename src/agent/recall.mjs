import { config } from '../config.mjs';
import { originallyGeneratedLabel, USER_STRINGS } from '../strings.mjs';
import { resolveDatePhrase, localDateTime } from '../time/resolve.mjs';

const RECALL_FRAMING = new RegExp(
  '\\b(?:asked|earlier|before|previously|we discussed|you recommended|the one where|remind me|'
  + 'last time|what did i|what was i asking|you told me|we talked about|since then)\\b',
  'i'
);

const STOPWORDS = new Set(
  ('a an the and or but of for from to in on at with about has have had did do does is are was were '
  + 'be been being it this that then now still correct change changed any since earlier before ago '
  + 'your you me my we our asked ask question answer where one what which when who how why can could '
  + 'should would will may sat second last first monday tuesday wednesday thursday friday saturday sunday'
  ).split(' ')
);

export function topicWords(rawText, matchedDateText = '') {
  const source = String(rawText || '').replace(matchedDateText, ' ').toLowerCase();
  const words = source.match(/[a-z0-9][a-z0-9._-]*/g) || [];
  return [...new Set(
    words.map((word) => word.replace(/[^a-z0-9]/g, ''))
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
  )].slice(0, 6);
}

function countMatches(turn, words) {
  const text = `${turn.user_text} ${turn.assistant_text} ${turn.source_titles_text || ''}`.toLowerCase();
  return words.filter((word) => text.includes(word)).length;
}

function scoreTurn(turn, words, now) {
  let bm25Score = 0;
  if (typeof turn.rank === 'number') {
    bm25Score = -turn.rank;
  } else {
    bm25Score = countMatches(turn, words);
  }
  const createdAt = turn.created_at_utc ? new Date(turn.created_at_utc).getTime() : 0;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageMs = Math.max(0, nowMs - createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyScore = 1 / (1 + ageDays / 7);
  return bm25Score * (1 + 0.15 * recencyScore) + 0.05 * recencyScore;
}

export function recallForTurn({ store, userText, timezone, now = new Date(), sessionId = null }) {
  const resolved = resolveDatePhrase(userText, timezone, now);
  const today = resolved.today;
  let recalled = [];
  let fact = null;
  let topicMatches = [];
  if (resolved.kind === 'ambiguous' || resolved.kind === 'multiple') {
    return {
      resolved,
      recalled,
      fact: 'The user mentioned multiple or ambiguous dates '
        + `(${resolved.matchedText}). Ask which date they mean before recalling.`,
      topicMatches,
    };
  }
  if (resolved.range && resolved.range.from <= today) {
    const toDate = resolved.range.to > today ? today : resolved.range.to;
    recalled = store.searchByDateRange(resolved.range.from, toDate, sessionId);
    if (!recalled.length) fact = `0 turns found from ${resolved.range.from} to ${toDate}`;
  } else if (resolved.range && resolved.range.from > today) {
    fact = `0 turns found from ${resolved.range.from} to ${resolved.range.to}`;
  } else if (resolved.date) {
    recalled = store.searchByDate(resolved.date, sessionId);
    if (recalled.length) {
      const turn = recalled[0];
      fact = `On ${resolved.date}, the user asked: "${turn.user_text}". You answered: "${turn.assistant_text}".`;
    } else {
      fact = `0 turns found for ${resolved.date}`;
    }
  } else {
    const words = topicWords(userText, resolved.matchedText);
    if (words.length) {
      let candidates = [];
      if (typeof store.searchByTopic === 'function') {
        candidates = store.searchByTopic(words, 12, sessionId) || [];
      }
      if (!candidates.length) {
        candidates = (store.searchRecent
          ? store.searchRecent(12, sessionId)
          : store.lastTurns?.(12, sessionId)) || [];
      }
      topicMatches = candidates
        .map((turn) => ({
          turn,
          score: scoreTurn(turn, words, now),
          matches: countMatches(turn, words),
        }))
        .filter((item) => item.matches > 0 || typeof item.turn.rank === 'number')
        .sort((a, b) => b.score - a.score);

      const budget = config.maxContextChars || 1500;
      let totalChars = 0;
      const selectedTurns = [];
      for (const item of topicMatches) {
        const turn = item.turn;
        const turnLen = (turn.user_text || '').length + (turn.assistant_text || '').length;
        if (selectedTurns.length > 0 && totalChars + turnLen > budget) {
          break;
        }
        selectedTurns.push(turn);
        totalChars += turnLen;
        if (selectedTurns.length >= 3) break;
      }
      recalled = selectedTurns;
    }
  }
  const emitMemory = Boolean(resolved.date || resolved.range || RECALL_FRAMING.test(userText));
  const memory = emitMemory ? recalled.map((turn) => ({
    id: turn.id,
    question: turn.user_text,
    answer: turn.assistant_text,
    displayed_at: localDateTime(turn.created_at_utc, turn.iana_timezone || timezone),
    created_at: turn.created_at_utc,
    source_created_at: turn.source_created_at_utc,
    originally_generated_at: turn.origin === 'imported' && turn.source_created_at_utc
      ? localDateTime(turn.source_created_at_utc, turn.iana_timezone || timezone) : null,
    generation_date_unknown: turn.origin === 'imported' && !turn.source_created_at_utc,
    originally_generated_label: turn.origin === 'imported' && turn.source_created_at_utc
      ? originallyGeneratedLabel(localDateTime(turn.source_created_at_utc, turn.iana_timezone || timezone)) : '',
    generation_date_unknown_label: turn.origin === 'imported' && !turn.source_created_at_utc
      ? USER_STRINGS.generationDateUnknown : '',
    origin: turn.origin,
  })) : [];
  if (!resolved.date && !resolved.range && topicMatches.length && !RECALL_FRAMING.test(userText)) {
    fact = `A related earlier turn mentions ${topicMatches[0].turn.user_text || 'this topic'}; `
      + 'use it only as a brief contextual hint unless the user asks to recall it.';
  }
  return { resolved, recalled, memory, fact, topicMatches };
}
