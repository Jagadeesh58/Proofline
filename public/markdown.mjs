const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[S\d+\]|https?:\/\/[^\s<>]+)/g;

function inlineTokens(value) {
  const tokens = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE)) {
    if (match.index > cursor) tokens.push({ type: 'text', value: value.slice(cursor, match.index) });
    const raw = match[0];
    if (raw.startsWith('**')) tokens.push({ type: 'bold', value: raw.slice(2, -2) });
    else if (raw.startsWith('`')) tokens.push({ type: 'code', value: raw.slice(1, -1) });
    else if (/^\[S\d+\]$/.test(raw)) tokens.push({ type: 'citation', value: raw });
    else {
      let url = raw;
      while (/[.,;:!?)]$/.test(url)) url = url.slice(0, -1);
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
        tokens.push({ type: 'link', value: url, href: url });
        if (raw.length > url.length) tokens.push({ type: 'text', value: raw.slice(url.length) });
      } catch { tokens.push({ type: 'text', value: raw }); }
    }
    cursor = match.index + raw.length;
  }
  if (cursor < value.length) tokens.push({ type: 'text', value: value.slice(cursor) });
  return tokens;
}

/** Parses a small safe Markdown subset into data; the UI creates DOM nodes from this tree. */
export function parseMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', tokens: inlineTokens(paragraph.join('\n')) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flushParagraph();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      blocks.push({ type: 'code-block', value: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flushParagraph(); continue; }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'ul' : 'ol';
      const items = [];
      while (index < lines.length) {
        const match = lines[index].match(type === 'ul' ? /^\s*[-*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/);
        if (!match) break;
        items.push(inlineTokens(match[1]));
        index += 1;
      }
      index -= 1;
      blocks.push({ type, items });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
