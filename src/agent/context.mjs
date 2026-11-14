import { originallyGeneratedLabel, USER_STRINGS } from '../strings.mjs';
import { localDateISO } from '../time/resolve.mjs';
import { config } from '../config.mjs';

export function buildSystemContext({ timezone, recall, store, sessionId = null }) {
  const now = new Date();
  const today = localDateISO(now, timezone);
  const recalledText = (recall.memory || []).map((turn, index) => {
    const originLabel = turn.originally_generated_at
      ? `${originallyGeneratedLabel(turn.originally_generated_at)}.`
      : turn.generation_date_unknown
        ? `${USER_STRINGS.generationDateUnknown}.`
        : '';
    return `RECALLED TURN ${index + 1}\nQuestion (verbatim): ${turn.question}\n`
      + `Answer (verbatim): ${turn.answer}\nDisplayed timestamp: ${turn.displayed_at}\n${originLabel}`;
  }).join('\n\n');
  const userLimit = Math.min(600, config.maxContextChars);
  const answerLimit = Math.min(1500, config.maxContextChars);
  const cap = (value, limit) => {
    const text = String(value || '');
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
  };
  const contextTurns = store.lastTurns(config.maxContextTurns, sessionId).map((turn) => ({
    question: cap(turn.user_text, userLimit), answer: cap(turn.assistant_text, answerLimit),
  }));
  const userContext = `Current date: ${today}\nCurrent time: ${now.toISOString()}\nValidated timezone: ${timezone}\n` +
    `${recall.fact ? `Recall fact: ${recall.fact}\n` : ''}` +
    `${recalledText ? `\nExact recalled history:\n${recalledText}\n` : ''}`;
  return { today, systemText: userContext, contextTurns };
}

export function conversationContents(contextTurns, userText) {
  const contents = [];
  for (const turn of contextTurns) {
    if (!turn.question || !turn.answer) continue;
    contents.push({ role: 'user', parts: [{ text: turn.question }] });
    contents.push({ role: 'model', parts: [{ text: turn.answer }] });
  }
  contents.push({ role: 'user', parts: [{ text: userText }] });
  return contents;
}
