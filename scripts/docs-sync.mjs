import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { computeBuildId } from './build-id.mjs';

function getGitCommit() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function syncDesignDocs(root = path.resolve('.')) {
  const designPath = path.join(root, 'DESIGN.md');
  if (!fs.existsSync(designPath)) return false;

  const currentCommit = getGitCommit();
  const currentBuildId = computeBuildId();
  const liveResultsPath = path.join(root, 'evals/results/live-latest.json');

  let measuredText = 'Not yet measured on this commit.';

  if (fs.existsSync(liveResultsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(liveResultsPath, 'utf8'));
      const commitMatch = !currentCommit || !data.commit || data.commit === currentCommit;
      const buildMatch = !currentBuildId || !data.build_id || data.build_id === currentBuildId;

      if (commitMatch && buildMatch && data.totalQuestions) {
        const nodeMajor = process.versions.node.split('.')[0];
        const tier = data.environment?.accountTier || 'free';
        const dateStr = data.date?.slice(0, 10) || 'unrecorded date';
        const ttftMed = ((data.ttft?.medianMs || 0) / 1000).toFixed(1);
        const ttftMax = ((data.ttft?.maxMs || 0) / 1000).toFixed(1);
        const latMed = ((data.totalLatency?.medianMs || 0) / 1000).toFixed(1);
        const latMax = ((data.totalLatency?.maxMs || 0) / 1000).toFixed(1);
        const faithful = data.citationFaithfulness?.faithfulQuotes ?? data.successful ?? 0;
        const totalQuotes = data.citationFaithfulness?.totalQuotes ?? data.successful ?? 0;
        const lines = [
          `On ${dateStr} with build id ${data.build_id || currentBuildId} on Node ${nodeMajor}:`,
          `- ${data.totalQuestions} benchmark queries evaluated on the ${tier} tier.`,
          `- Time to first token: median ${ttftMed} s, max ${ttftMax} s.`,
          `- Total latency: median ${latMed} s, max ${latMax} s.`,
          `- Model calls per turn: median ${data.callsPerTurn?.median ?? '—'}. `
            + `Searches per turn: median ${data.searchesPerTurn?.median ?? '—'}.`,
          `- Citation faithfulness: ${faithful}/${totalQuotes} verbatim quotes.`,
          `- Cold container boot from idle and third-party scraping blocks are not measured in CI.`,
        ];
        measuredText = lines.join('\n');
      }
    } catch {
      // Malformed or empty results file defaults to not measured
    }
  }

  const design = fs.readFileSync(designPath, 'utf8');
  const startMarker = '<!-- measured:start -->';
  const endMarker = '<!-- measured:end -->';

  let nextDesign;
  if (design.includes(startMarker) && design.includes(endMarker)) {
    const before = design.slice(0, design.indexOf(startMarker) + startMarker.length);
    const after = design.slice(design.indexOf(endMarker));
    nextDesign = `${before}\n${measuredText}\n${after}`;
  } else {
    nextDesign = design.replace(
      /## Measured[\s\S]*$/,
      `## Measured\n\n${startMarker}\n${measuredText}\n${endMarker}\n`
    );
  }

  fs.writeFileSync(designPath, nextDesign, 'utf8');
  return true;
}

const isDirectSync = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

if (isDirectSync) {
  syncDesignDocs();
  process.stdout.write('Synchronised DESIGN.md measured block.\n');
}
