import { checkAnswerFigures, hasFigureTokens } from './figure-check.mjs';

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'approx', 'etc', 'inc', 'ltd', 'mr', 'mrs', 'ms', 'dr', 'prof',
  'corp', 'co', 'dept', 'est', 'min', 'max', 'jr', 'sr', 'no', 'vol', 'al', 'fig',
]);

export function sentenceEndIndex(value) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!'.!?'.includes(character)) continue;

    // Period directly followed by a digit is a decimal number (e.g. 19.99, 3.14, .5, 18.5%)
    if (character === '.' && /\d/.test(value[index + 1] || '')) continue;

    // Period followed by URL or domain continuation (e.g. example.com, node:sqlite)
    if (character === '.' && /[a-z0-9/_-]/i.test(value[index + 1] || '')) continue;

    // Single capital letter abbreviation / initials (e.g. "J. Smith", "A. Doe")
    if (character === '.' && /(?:^|\s)[A-Z]$/.test(value.slice(0, index))) continue;

    if (character === '.') {
      const prefix = value.slice(0, index + 1).match(/(?:^|\s)([a-z]+)\.$/i)?.[1]?.toLowerCase();
      if (prefix && ABBREVIATIONS.has(prefix)) continue;
      if (/(?:^|\s)(?:e\.g|i\.e)\.$/i.test(value.slice(0, index + 1))) continue;
      if (['e', 'i'].includes(prefix) && /^[ge]\./i.test(value.slice(index + 1))) continue;
      const lineStart = value.lastIndexOf('\n', index - 1) + 1;
      if (/^\s*\d+$/.test(value.slice(lineStart, index))) continue;
    }

    // Trailing quotes or closing brackets (e.g. ." or .')
    let nextPos = index + 1;
    while (nextPos < value.length && ['"', "'", ')', ']', '}'].includes(value[nextPos])) {
      nextPos += 1;
    }

    // Trailing citation markers attached to the sentence end (e.g. . [S1] or .[S1] or . [S1, S2])
    const tail = value.slice(nextPos);
    const citationMatch = tail.match(/^(?:\s*\[S\d+(?:,\s*S\d+)*\])+/i);
    if (citationMatch) {
      nextPos += citationMatch[0].length;
      while (nextPos < value.length && ['"', "'", ')', ']', '}'].includes(value[nextPos])) {
        nextPos += 1;
      }
    }

    if (nextPos >= value.length || /\s/.test(value[nextPos])) {
      return nextPos;
    }
  }
  return -1;
}

export function splitSentences(value) {
  const text = String(value || '');
  if (!text) return [];
  const sentences = [];
  let pending = text;
  let end = sentenceEndIndex(pending);
  while (end > 0) {
    const s = pending.slice(0, end).trim();
    if (s) sentences.push(s);
    pending = pending.slice(end).trimStart();
    end = sentenceEndIndex(pending);
  }
  if (pending.trim()) {
    sentences.push(pending.trim());
  }
  return sentences.length ? sentences : [text];
}

function emitSafely(send, type, payload) {
  try { send(type, payload); } catch { /* A disconnected browser must not interrupt persistence. */ }
}

/** Checks figure-bearing sentences after extraction while allowing narrative text to stream immediately. */
export function createSentenceGate({ send, store, turnId, getContext, extractionPromise }) {
  let pending = '';
  let queue = Promise.resolve();
  let emitted = '';

  const emitSentence = (sentence) => {
    queue = queue.then(async () => {
      if (extractionPromise && hasFigureTokens(sentence)) {
        try { await extractionPromise; } catch { /* Failed extraction leaves claims unavailable. */ }
      }
      const leadingWhitespace = sentence.match(/^\s*/)?.[0] || '';
      const checked = checkAnswerFigures(sentence, getContext());
      let textToEmit = checked.text;
      if (textToEmit) {
        if (leadingWhitespace && !textToEmit.startsWith(leadingWhitespace)) {
          textToEmit = leadingWhitespace + textToEmit;
        }
        if (emitted && !/\s$/.test(emitted) && !/^\s/.test(textToEmit)) {
          textToEmit = ` ${textToEmit}`;
        }
        emitted += textToEmit;
        store.appendAssistantText(turnId, textToEmit);
        emitSafely(send, 'token', { text: textToEmit });
      }
      for (const marker of checked.markers) emitSafely(send, 'figure_marker', marker);
    });
  };

  return {
    push(chunk) {
      pending += chunk;
      let end = sentenceEndIndex(pending);
      while (end >= 0) {
        const sentence = pending.slice(0, end);
        pending = pending.slice(end);
        emitSentence(sentence);
        end = sentenceEndIndex(pending);
      }
    },
    async flush() {
      if (pending) { emitSentence(pending); pending = ''; }
      await queue;
      return emitted;
    },
  };
}
