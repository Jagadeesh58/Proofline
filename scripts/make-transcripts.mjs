import fs from 'node:fs';
import path from 'node:path';

export function makeTranscripts(resultsPath = 'evals/results/live-latest.json', outputDir = 'evals/transcripts') {
  if (!fs.existsSync(resultsPath)) return false;
  const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  const results = data.results || [];
  fs.mkdirSync(outputDir, { recursive: true });

  const promptMatchers = [
    { id: 1, file: 'official-1.md', match: /CRM tools/i, title: 'Official Prompt 1' },
    { id: 2, file: 'official-2.md', match: /3 November/i, title: 'Official Prompt 2' },
    { id: 3, file: 'official-3.md', match: /Postgres hosting/i, title: 'Official Prompt 3' },
  ];

  for (const item of promptMatchers) {
    const entry = results.find((r) => item.match.test(r.prompt || ''));
    if (!entry) continue;

    const firstToken = entry.firstTokenMs != null ? `${entry.firstTokenMs} ms` : '—';
    const total = entry.totalTimeMs != null ? `${entry.totalTimeMs} ms` : '—';
    const cards = entry.cardsCount ?? (Array.isArray(entry.cards) ? entry.cards.length : 0);
    const sources = entry.sourcesCount ?? (Array.isArray(entry.sources) ? entry.sources.length : 0);
    const calls = entry.geminiCalls ?? entry.modelCalls ?? '—';
    const searches = entry.searchesRun ?? entry.searches ?? '—';

    const content = [
      `# Live Transcript: ${item.title}`,
      '',
      `- **Run ID**: \`${data.build_id || 'unrecorded'}\``,
      `- **Commit**: \`${data.commit || 'head'}\``,
      `- **Prompt**: "${entry.prompt}"`,
      `- **Model**: \`${data.environment?.model || 'gemini-3.5-flash-lite'}\` `
        + `(${data.environment?.accountTier || 'free'} tier)`,
      `- **Time to first token**: ${firstToken}`,
      `- **Total duration**: ${total}`,
      `- **Cards**: ${cards} comparison cards`,
      `- **Sources**: ${sources} sources retrieved`,
      `- **Model calls**: ${calls}`,
      `- **Searches**: ${searches}`,
      '',
      '## Answer',
      '',
      entry.answer || entry.answerPreview || '(No answer text recorded)',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(outputDir, item.file), content, 'utf8');
  }
  return true;
}

const isDirectTranscripts = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

if (isDirectTranscripts) {
  const fileArg = process.argv[2] || 'evals/results/live-latest.json';
  makeTranscripts(fileArg);
  process.stdout.write('Transcripts generated.\n');
}
