const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ABBREVIATIONS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseMonthName(name) {
  const lower = String(name || '').toLowerCase().trim();
  const fullIndex = MONTHS.indexOf(lower);
  if (fullIndex >= 0) return fullIndex + 1;
  const shortIndex = MONTH_ABBREVIATIONS[lower.slice(0, 3)];
  return shortIndex || null;
}

const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11],
  ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15],
  ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
]);

export function localDateParts(date = new Date(), timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

export function localDateISO(date = new Date(), timezone = 'UTC') {
  const p = localDateParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isValidTimezone(timezone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); return true; }
  catch { return false; }
}

function shiftISO(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-`
    + `${String(value.getUTCDate()).padStart(2, '0')}`;
}

function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function validISO(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function mondayOf(iso) {
  const weekday = weekdayOf(iso);
  return shiftISO(iso, -(weekday === 0 ? 6 : weekday - 1));
}

function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

function shiftMonth(year, month, deltaMonths) {
  const totalMonths = (year * 12 + (month - 1)) + deltaMonths;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12 + 1;
  return { year: targetYear, month: targetMonth };
}

function lastWeekendRange(today) {
  const thisMonday = mondayOf(today);
  const from = shiftISO(thisMonday, -2);
  const to = shiftISO(thisMonday, -1);
  return { from, to };
}

function parseRangeDateComponent(str, today, context = {}) {
  const text = String(str || '').trim().toLowerCase();
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    const date = validISO(y, m, d);
    if (date) {
      context.year = y;
      context.month = m;
      return date;
    }
  }
  const monthPattern = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|'
    + 'aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const monthFirst = new RegExp(
    `\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    'i'
  );
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`,
    'i'
  );
  const mf = text.match(monthFirst);
  if (mf) {
    const month = parseMonthName(mf[1]);
    const day = Number(mf[2]);
    const year = Number(mf[3] || today.slice(0, 4));
    let date = validISO(year, month, day);
    if (date && !mf[3] && date > today) date = validISO(year - 1, month, day);
    if (date) {
      context.month = month;
      context.year = year;
      return date;
    }
  }
  const df = text.match(dayFirst);
  if (df) {
    const day = Number(df[1]);
    const month = parseMonthName(df[2]);
    const year = Number(df[3] || today.slice(0, 4));
    let date = validISO(year, month, day);
    if (date && !df[3] && date > today) date = validISO(year - 1, month, day);
    if (date) {
      context.month = month;
      context.year = year;
      return date;
    }
  }
  const bareDay = text.match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (bareDay && context.month && context.year) {
    const day = Number(bareDay[1]);
    return validISO(context.year, context.month, day);
  }
  const weekdayMatch = text.match(
    /\b(?:(last|this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
  );
  if (weekdayMatch) {
    const prefix = (weekdayMatch[1] || '').toLowerCase();
    const target = WEEKDAYS.indexOf(weekdayMatch[2].toLowerCase());
    if (context.baseDate) {
      const baseDay = weekdayOf(context.baseDate);
      let delta = (target - baseDay + 7) % 7;
      if (delta === 0 && prefix === 'next') delta = 7;
      return shiftISO(context.baseDate, delta);
    }
    const current = weekdayOf(today);
    let delta;
    if (prefix === 'next') {
      delta = (target - current + 7) % 7;
      if (delta === 0) delta = 7;
    } else if (prefix === 'last') {
      delta = (target - current - 7) % 7;
      if (delta === 0) delta = -7;
    } else if (prefix === 'this') {
      const thisMonday = mondayOf(today);
      const targetOffset = target === 0 ? 6 : target - 1;
      return shiftISO(thisMonday, targetOffset);
    } else {
      delta = (target - current - 7) % 7;
      if (delta === 0) delta = -7;
    }
    return shiftISO(today, delta);
  }
  if (/\byesterday\b/i.test(text)) return shiftISO(today, -1);
  if (/\btoday\b/i.test(text)) return today;
  return null;
}

function parseDateRangeSpan(startPart, endPart, today) {
  const context = {};
  const d1 = parseRangeDateComponent(startPart, today, context);
  if (!d1) return null;
  context.baseDate = d1;
  const d2 = parseRangeDateComponent(endPart, today, context);
  if (!d2) return null;
  return d1 <= d2 ? { from: d1, to: d2 } : { from: d2, to: d1 };
}

function collectMatches(text, regex, mapper, priority) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    const value = mapper(match);
    if (value) matches.push({ ...value, priority, index: match.index });
  }
  return matches;
}

function skipProductWeekday(text, match) {
  const after = text.slice(match.index + match[0].length);
  return /^(?:\.com|\.app|\.io|\s+(?:crm|board|work)\b)/i.test(after);
}

function chooseCandidate(candidates, today) {
  if (!candidates.length) return { kind: 'none', date: null, matchedText: '', today };
  const priority = Math.min(...candidates.map((item) => item.priority));
  const selected = candidates.filter((item) => item.priority === priority);
  const dates = [...new Set(selected.map((item) => item.date || `${item.range?.from}:${item.range?.to}`))];
  if (dates.length > 1) {
    return {
      kind: 'multiple',
      date: null,
      range: null,
      matchedText: selected.map((item) => item.matchedText).join(', '),
      dates,
      today,
    };
  }
  const result = selected[0];
  return {
    kind: result.kind,
    date: result.date || null,
    range: result.range || null,
    matchedText: result.matchedText,
    today,
  };
}

/** Resolves date phrases by semantic priority, avoiding incidental product names and numeric ranges. */
export function resolveDatePhrase(text, timezone = 'UTC', now = new Date()) {
  const input = String(text || '');
  const today = localDateISO(now, timezone);
  const candidates = [];
  const monthPattern = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|'
    + 'aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  candidates.push(...collectMatches(input, /\b\d{4}-\d{2}-\d{2}\b/g, (match) => {
    const [year, month, day] = match[0].split('-').map(Number);
    const date = validISO(year, month, day);
    return date ? { kind: 'iso', date, matchedText: match[0] } : { kind: 'invalid', date: null, matchedText: match[0] };
  }, 0));

  const betweenRegex = /\bbetween\s+([a-z0-9\s,.-]+?)\s+and\s+([a-z0-9\s,.-]+?)(?=[.,;?!]|$)/gi;
  candidates.push(...collectMatches(input, betweenRegex, (match) => {
    const range = parseDateRangeSpan(match[1], match[2], today);
    return range ? { kind: 'range', range, matchedText: match[0].trim() } : null;
  }, -1));

  const fromToRegex = /\bfrom\s+([a-z0-9\s,.-]+?)\s+(?:to|through|until)\s+([a-z0-9\s,.-]+?)(?=[.,;?!]|$)/gi;
  candidates.push(...collectMatches(input, fromToRegex, (match) => {
    const range = parseDateRangeSpan(match[1], match[2], today);
    return range ? { kind: 'range', range, matchedText: match[0].trim() } : null;
  }, -1));

  const monthFirst = new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`, 'gi');
  candidates.push(...collectMatches(input, monthFirst, (match) => {
    const month = parseMonthName(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3] || today.slice(0, 4));
    let date = validISO(year, month, day);
    if (!date) return { kind: 'invalid', date: null, matchedText: match[0] };
    if (!match[3] && date > today) date = validISO(year - 1, month, day);
    return { kind: 'calendar', date, matchedText: match[0] };
  }, 1));
  candidates.push(...collectMatches(input, dayFirst, (match) => {
    const day = Number(match[1]);
    const month = parseMonthName(match[2]);
    const year = Number(match[3] || today.slice(0, 4));
    let date = validISO(year, month, day);
    if (!date) return { kind: 'invalid', date: null, matchedText: match[0] };
    if (!match[3] && date > today) date = validISO(year - 1, month, day);
    return { kind: 'calendar', date, matchedText: match[0] };
  }, 1));

  const numericTriple = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
  candidates.push(...collectMatches(input, numericTriple, (match) => ({
    kind: 'ambiguous', date: null, matchedText: match[0],
  }), 1));
  const numericPair = /\b(\d{1,2})\/(\d{1,2})\b/g;
  candidates.push(...collectMatches(input, numericPair, (match) => {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const after = input.slice(match.index + match[0].length);
    if (/^\s*of\b/i.test(after)) return null;
    return first >= 1 && first <= 31 && second >= 1 && second <= 12
      ? { kind: 'ambiguous', date: null, matchedText: match[0] } : null;
  }, 1));

  const ordinalDay = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;
  candidates.push(...collectMatches(input, ordinalDay, (match) => {
    const day = Number(match[1]);
    if (day < 1 || day > 31) return null;
    const [y, m] = today.split('-').map(Number);
    let date = validISO(y, m, day);
    if (!date || date > today) {
      const prevM = m === 1 ? 12 : m - 1;
      const prevY = m === 1 ? y - 1 : y;
      date = validISO(prevY, prevM, day);
    }
    return date ? { kind: 'calendar', date, matchedText: match[0] } : null;
  }, 1));

  const nWeekdaysAgo = new RegExp(
    '\\b(\\d+|two|three|four|five)\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\\s+ago\\b',
    'gi'
  );
  candidates.push(...collectMatches(input, nWeekdaysAgo, (match) => {
    const count = Number(match[1]) || NUMBER_WORDS.get(match[1].toLowerCase());
    if (!count || count < 1) return null;
    const target = WEEKDAYS.indexOf(match[2].toLowerCase());
    const current = weekdayOf(today);
    let delta = (target - current - 7) % 7;
    if (delta === 0) delta = -7;
    const totalDays = delta - (count - 1) * 7;
    return { kind: 'weekday', date: shiftISO(today, totalDays), matchedText: match[0] };
  }, 2));

  const weekdayRegex = /\b(?:(last|this|on|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
  candidates.push(...collectMatches(input, weekdayRegex, (match) => {
    if (skipProductWeekday(input, match)) return null;
    const prefix = (match[1] || '').toLowerCase();
    const target = WEEKDAYS.indexOf(match[2].toLowerCase());
    const current = weekdayOf(today);

    let delta;
    if (prefix === 'next') {
      delta = (target - current + 7) % 7;
      if (delta === 0) delta = 7;
    } else if (prefix === 'last') {
      delta = (target - current - 7) % 7;
      if (delta === 0) delta = -7;
    } else if (prefix === 'this') {
      const thisMonday = mondayOf(today);
      const targetOffset = target === 0 ? 6 : target - 1;
      return { kind: 'weekday', date: shiftISO(thisMonday, targetOffset), matchedText: match[0] };
    } else {
      const pastContext = new RegExp(
        '\\b(ask(?:ed)?|shortlist(?:ed)?|decid(?:ed|e)|talk(?:ed)?|'
        + 'met|discuss(?:ed)?|remember|conversation|last time)\\b',
        'i'
      ).test(input);
      const futureContext = new RegExp(
        '\\b(weather|forecast|schedule|meeting|available|upcoming|reservation|appointment)\\b',
        'i'
      ).test(input);
      if (prefix === 'on' && pastContext) {
        delta = (target - current - 7) % 7;
        if (delta === 0) delta = -7;
      } else if (pastContext || (!prefix && !futureContext)) {
        delta = (target - current - 7) % 7;
        if (delta === 0) delta = -7;
      } else {
        delta = (target - current + 7) % 7;
        if (delta === 0) delta = 7;
      }
    }
    return { kind: 'weekday', date: shiftISO(today, delta), matchedText: match[0] };
  }, 2));

  candidates.push(...collectMatches(
    input,
    /\b(the\s+day\s+before\s+yesterday|day\s+before\s+yesterday|yesterday)\b/gi,
    (match) => {
      const isYesterday = /yesterday$/i.test(match[1]) && !/before\s+yesterday$/i.test(match[1]);
      return {
        kind: 'relative',
        date: shiftISO(today, isYesterday ? -1 : -2),
        matchedText: match[0],
      };
    },
    3
  ));

  candidates.push(...collectMatches(input, /\bthis morning\b/gi, (match) => ({
    kind: 'relative', date: today, matchedText: match[0],
  }), 3));

  candidates.push(...collectMatches(input, /\b(?:a\s+)?couple\s+of\s+days?\s+ago\b/gi, (match) => ({
    kind: 'relative', date: shiftISO(today, -2), matchedText: match[0],
  }), 4));

  const nDaysAgo = new RegExp(
    '\\b(a|\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|'
    + 'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\\s+days?\\s+ago\\b',
    'gi'
  );
  candidates.push(...collectMatches(input, nDaysAgo, (match) => {
    const raw = match[1].toLowerCase();
    const amount = raw === 'a' ? 1 : (Number(raw) || NUMBER_WORDS.get(raw));
    return amount ? { kind: 'relative', date: shiftISO(today, -amount), matchedText: match[0] } : null;
  }, 4));

  const weekMatch = /\b(a|an|\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+weeks?\s+ago\b/gi;
  candidates.push(...collectMatches(input, weekMatch, (match) => {
    const raw = match[1].toLowerCase();
    const amount = (raw === 'a' || raw === 'an') ? 1 : (Number(raw) || NUMBER_WORDS.get(raw));
    if (!amount) return null;
    if (amount === 1) {
      return {
        kind: 'relative',
        date: shiftISO(today, -7),
        range: { from: shiftISO(today, -7), to: shiftISO(today, -7) },
        matchedText: match[0],
      };
    }
    const from = mondayOf(shiftISO(today, -(amount * 7)));
    return { kind: 'range', range: { from, to: shiftISO(from, 6) }, matchedText: match[0] };
  }, 5));

  const nMonthsAgo = new RegExp(
    '\\b(a|an|\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+months?\\s+ago\\b',
    'gi'
  );
  candidates.push(...collectMatches(input, nMonthsAgo, (match) => {
    const raw = match[1].toLowerCase();
    const amount = (raw === 'a' || raw === 'an') ? 1 : (Number(raw) || NUMBER_WORDS.get(raw));
    if (!amount) return null;
    const [y, m] = today.split('-').map(Number);
    const { year, month } = shiftMonth(y, m, -amount);
    return { kind: 'range', range: monthRange(year, month), matchedText: match[0] };
  }, 5));

  candidates.push(...collectMatches(input, /\bearlier this month\b/gi, (match) => {
    const [y, m] = today.split('-').map(Number);
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    return { kind: 'range', range: { from, to: today }, matchedText: match[0] };
  }, 5.5));

  candidates.push(...collectMatches(input, /\b(?<!earlier\s+)this month\b/gi, (match) => {
    const [y, m] = today.split('-').map(Number);
    return { kind: 'range', range: monthRange(y, m), matchedText: match[0] };
  }, 6));

  candidates.push(...collectMatches(input, /\blast month\b/gi, (match) => {
    const [y, m] = today.split('-').map(Number);
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    const from = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
    const to = `${prevY}-${String(prevM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { kind: 'range', range: { from, to }, matchedText: match[0] };
  }, 6));

  candidates.push(...collectMatches(input, /\blast weekend\b/gi, (match) => {
    const range = lastWeekendRange(today);
    return { kind: 'range', range, matchedText: match[0] };
  }, 6));

  const monthOnlyRegex = new RegExp(
    `\\b(?:(in|last|this|during|throughout)\\s+)?(${monthPattern})(?:\\s+(\\d{4}))?\\b`
    + `(?!\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)(?!\\.com|\\.app|\\.io|\\s+(?:crm|board|work)\\b)`,
    'gi'
  );
  candidates.push(...collectMatches(input, monthOnlyRegex, (match) => {
    const prefix = (match[1] || '').toLowerCase();
    const month = parseMonthName(match[2]);
    const explicitYear = match[3] ? Number(match[3]) : null;
    if (!prefix && !explicitYear) return null;
    const [currY, currM] = today.split('-').map(Number);
    let year = explicitYear;
    if (!year) {
      if (prefix === 'last') {
        year = month < currM ? currY : currY - 1;
      } else if (prefix === 'this') {
        year = currY;
      } else {
        year = month <= currM ? currY : currY - 1;
      }
    }
    const range = monthRange(year, month);
    return { kind: 'range', range, matchedText: match[0] };
  }, 6));

  candidates.push(...collectMatches(input, /\blast week\b/gi, (match) => {
    const thisMonday = mondayOf(today);
    return {
      kind: 'range',
      range: { from: shiftISO(thisMonday, -7), to: shiftISO(thisMonday, -1) },
      matchedText: match[0],
    };
  }, 6));
  candidates.push(...collectMatches(input, /\bthis week\b/gi, (match) => ({
    kind: 'range', range: { from: mondayOf(today), to: shiftISO(mondayOf(today), 6) }, matchedText: match[0],
  }), 7));
  candidates.push(...collectMatches(input, /\btomorrow\b/gi, (match) => ({
    kind: 'relative', date: shiftISO(today, 1), matchedText: match[0],
  }), 8));
  candidates.push(...collectMatches(input, /\btoday\b/gi, (match) => ({
    kind: 'relative', date: today, matchedText: match[0],
  }), 9));

  const result = chooseCandidate(candidates, today);
  if (result.kind === 'ambiguous' || result.kind === 'invalid' || result.kind === 'multiple') return result;
  if (result.kind === 'none') return { ...result, range: null };
  return result;
}

/** Resolves a past week to a Monday-to-Sunday range for local-history recall. */
export function resolveDateRange(text, timezone = 'UTC', now = new Date()) {
  const result = resolveDatePhrase(text, timezone, now);
  return result.range || null;
}

/** Resolves a date explicitly scoped by since, after or from; unrelated dates are ignored. */
export function resolveSinceDate(text, timezone = 'UTC', now = new Date()) {
  const input = String(text || '');
  const monthPat = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|'
    + 'aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const match = input.match(new RegExp(
    '\\b(?:since|after|from)\\s+(?<phrase>last week|this week|last month|earlier this month|'
    + 'this month|last weekend|a week ago|'
    + 'yesterday|day before yesterday|the day before yesterday|today|this morning|'
    + '(?:on\\s+)?the\\s+\\d{1,2}(?:st|nd|rd|th)|'
    + '(?:\\d+|two|three|four|five)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\\s+ago|'
    + '(?:last|this|next|on)\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|'
    + '(?:a|an|\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|'
    + 'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\\s+(?:days?|weeks?|months?)\\s+ago|'
    + '(?:a\\s+)?couple\\s+of\\s+days?\\s+ago|'
    + '\\d{4}-\\d{2}-\\d{2}|'
    + '\\d{1,2}(?:st|nd|rd|th)?\\s+' + monthPat + '(?:,?\\s+\\d{4})?|'
    + monthPat + '\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|'
    + '(?:in|last|this)?\\s*' + monthPat + '(?:\\s+\\d{4})?|'
    + 'monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b',
    'i'
  ));
  if (!match) return null;
  const phrase = match.groups.phrase;
  if (/^last week$/i.test(phrase)) return shiftISO(localDateISO(now, timezone), -7);
  if (/^this week$/i.test(phrase)) return mondayOf(localDateISO(now, timezone));
  if (/^last month$/i.test(phrase)) {
    const [y, m] = localDateISO(now, timezone).split('-').map(Number);
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    return `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  }
  const result = resolveDatePhrase(phrase, timezone, now);
  return ['ambiguous', 'multiple', 'invalid'].includes(result.kind)
    ? null
    : (result.date || result.range?.from || null);
}

export function localDateTime(utcIso, timezone = 'UTC') {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function localDateFromUtc(utcIso, timezone = 'UTC') {
  return localDateISO(new Date(utcIso), timezone);
}
