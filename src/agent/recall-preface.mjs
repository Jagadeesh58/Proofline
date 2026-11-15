function formatSnippet(text, maxLength = 160) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  const cut = collapsed.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const wordBoundaryCut = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${wordBoundaryCut}…`;
}

export function buildRecallPreface({ recall, timezone = 'UTC', willSearch = false } = {}) {
  if (!recall?.resolved?.date || !Array.isArray(recall?.recalled) || recall.recalled.length === 0) {
    return '';
  }

  const firstTurn = recall.recalled[0];
  const dateStr = firstTurn.local_date || recall.resolved.date;
  const dateObj = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(dateObj.getTime())) return '';

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const formattedDate = formatter.format(dateObj);

  const snippet = formatSnippet(firstTurn.user_text || '');
  const sameDateTurns = (recall.recalled || []).filter(
    (turn) => (turn.local_date || turn.created_at?.slice(0, 10)) === dateStr,
  );
  const otherCount = sameDateTurns.length - 1;
  const moreText = otherCount > 0 ? ` (${otherCount} more that day)` : '';

  let preface = `On ${formattedDate} you asked: "${snippet}"${moreText}.`;
  if (willSearch) {
    preface += ' Checking what has changed since.';
  }
  return `${preface}\n\n`;
}
