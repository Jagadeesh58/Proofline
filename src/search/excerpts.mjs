const TOKENS = new RegExp(
  '(?:\\$|₹|€|£)\\s?\\d[\\d,.]*|\\b\\d+(?:\\.\\d+){1,3}\\b|'
  + '\\b(?:pricing|price|month|year|annual|monthly|per seat|per user|per member|per agent|'
  + 'per host|free|starter|professional|pro|enterprise|contacts|storage|gb|api calls|requests|'
  + 'updated|effective|released|version)\\b',
  'gi'
);

export function extractPageDate(text) {
  const monthNames = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
  const pattern = new RegExp(
    '\\b(?:last\\s+updated|updated|effective|prices?\\s+as\\s+of|published|released)\\s*[:\\-]?\\s*'
    + `(${monthNames}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${monthNames}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
    'i'
  );
  return text.match(pattern)?.[0] || null;
}

/** Keeps a bounded page excerpt centred on plan and numeric evidence rather than sending a whole site. */
export function excerptWindow(pageText, baselinePlan = '') {
  const text = String(pageText || '').slice(0, 80_000);
  const centres = [];
  const terms = [baselinePlan, ...Array.from(text.matchAll(TOKENS), (match) => match[0])].filter(Boolean);
  for (const term of terms.slice(0, 28)) {
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    if (index >= 0) centres.push(index);
  }
  if (!centres.length) return text.slice(0, 5000);
  const ranges = [];
  for (const centre of centres) {
    const start = Math.max(0, centre - 550);
    const end = Math.min(text.length, centre + 1100);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end + 180) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  return ranges.slice(0, 5)
    .map(({ start, end }) => text.slice(start, end))
    .join('\n[… page excerpt …]\n')
    .slice(0, 12_000);
}
