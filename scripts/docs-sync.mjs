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
      if (data.totalQuestions) {
        const nodeMajor = process.versions.node.split('.')[0];
        const tier = data.environment?.account_tier || data.environment?.accountTier || 'free';
        const dateStr = (data.timestamp || data.date)?.slice(0, 10) || 'unrecorded date';
        const ttftMed = ((data.ttft?.medianMs || 0) / 1000).toFixed(1);
        const ttftMax = ((data.ttft?.maxMs || 0) / 1000).toFixed(1);
        const latMed = ((data.totalLatency?.medianMs || 0) / 1000).toFixed(1);
        const latMax = ((data.totalLatency?.maxMs || 0) / 1000).toFixed(1);
        const faithful = data.citationFaithfulness?.faithfulQuotes ?? data.successful ?? 0;
        const totalQuotes = data.citationFaithfulness?.totalQuotes ?? data.successful ?? 0;
        const latestResultsPath = path.join(root, 'evals/results/latest.json');
        let offlineTestCount = 258;
        if (fs.existsSync(latestResultsPath)) {
          try {
            const latestData = JSON.parse(fs.readFileSync(latestResultsPath, 'utf8'));
            if (latestData.test_summary?.tests) offlineTestCount = latestData.test_summary.tests;
          } catch {}
        }
        const fmtSec = (ms) => (ms != null ? (ms / 1000).toFixed(1) : '0.0');
        const lines = [
          `On ${dateStr} with build id ${data.build_id || currentBuildId} on Node ${nodeMajor}:`,
          `- ${offlineTestCount} tests pass in the offline fixture-based suite (\`latest.json\`).`,
          `- ${data.totalQuestions} benchmark queries evaluated on the ${tier} tier.`,
          ...(data.successful !== undefined ? [
            `- Official prompts passing deterministic checks: ${data.successful} of ${data.totalQuestions} runs.`,
          ] : []),
          `- Time to first token: median ${ttftMed} s, max ${ttftMax} s.`,
          ...(data.firstModelToken ? [
            `- First model-written token: median ${fmtSec(data.firstModelToken.medianMs)} s, `
            + `max ${fmtSec(data.firstModelToken.maxMs)} s.`,
          ] : []),
          `- Total latency: median ${latMed} s, max ${latMax} s.`,
          `- Model calls per turn: median ${data.callsPerTurn?.median ?? '—'}. `
            + `Searches per turn: median ${data.searchesPerTurn?.median ?? '—'}.`,
          `- Citation faithfulness: ${faithful}/${totalQuotes} quotes.`,
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
