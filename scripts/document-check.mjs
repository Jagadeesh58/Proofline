import fs from 'node:fs';
import path from 'node:path';
import { computeBuildId } from './build-id.mjs';

const root = path.resolve('.');
const documents = ['README.md', 'DESIGN.md'];
const americanSpellings = new Set([
  'behavior', 'behaviors', 'behavioral', 'color', 'colors', 'colorful', 'center', 'centers',
  'centralized', 'centralize', 'customize', 'customized', 'customizing', 'prioritize', 'prioritized',
  'prioritizing', 'normalize', 'normalized', 'normalizing', 'organization', 'organizations',
  'organize', 'organized', 'organizing', 'analyze', 'analyzed', 'analyzing', 'catalog',
  'canceled', 'canceling', 'labeled', 'labeling', 'traveling', 'traveled', 'licensee',
]);
const bannedPhrases = [
  '100%', 'guarantee', 'flawless', 'seamless', 'robust',
  'bulletproof', 'world-class', 'state-of-the-art', 'zero-risk',
];
const failures = [];
const contentByFile = new Map();

function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
}
function slug(heading) {
  return heading.toLowerCase().replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N} -]/gu, '').trim().replace(/\s+/g, '-');
}
function anchors(text) {
  const headingLines = text.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line));
  return new Set(headingLines.map((line) => slug(line.replace(/^#{1,6}\s+/, ''))));
}

for (const filename of documents) {
  const full = path.join(root, filename);
  if (!fs.existsSync(full)) {
    failures.push(`${filename}: file does not exist.`);
    continue;
  }
  const text = fs.readFileSync(full, 'utf8');
  contentByFile.set(filename, text);
  const plain = stripCode(text);
  for (const match of plain.matchAll(/\b[A-Za-z]+\b/g)) {
    if (americanSpellings.has(match[0].toLowerCase())) {
      failures.push(`${filename}: American spelling "${match[0]}"; use British English.`);
    }
  }
  for (const phrase of bannedPhrases) {
    const re = new RegExp(`\\b${phrase.replace('%', '\\%')}\\b`, 'i');
    if (re.test(plain)) {
      failures.push(`${filename}: Contains banned promotional phrase "${phrase}".`);
    }
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const destination = match[1].split(/[?#]/, 1)[0];
    const fragment = match[1].includes('#') ? match[1].slice(match[1].indexOf('#') + 1) : '';
    if (!destination || /^[a-z]+:/i.test(destination) || destination.startsWith('//')) continue;
    const target = path.resolve(path.dirname(full), decodeURIComponent(destination));
    if (!target.startsWith(root + path.sep) && target !== root) {
      failures.push(`${filename}: link escapes project: ${match[1]}`);
      continue;
    }
    if (!fs.existsSync(target)) {
      failures.push(`${filename}: missing link target ${match[1]}`);
      continue;
    }
    if (fragment && fs.statSync(target).isFile() && target.endsWith('.md')) {
      const relative = path.relative(root, target).split(path.sep).join('/');
      const targetText = contentByFile.get(relative) ?? fs.readFileSync(target, 'utf8');
      if (!anchors(targetText).has(decodeURIComponent(fragment).toLowerCase())) {
        failures.push(`${filename}: missing anchor ${match[1]}`);
      }
    }
  }
}

const design = contentByFile.get('DESIGN.md') || '';
const designWords = (stripCode(design).match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length;
if (designWords > 550) {
  failures.push(`DESIGN.md: ${designWords} words exceeds the 550 word limit.`);
}

const readme = contentByFile.get('README.md') || '';
const readmeWords = (stripCode(readme).match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) || []).length;
if (readmeWords < 180 || readmeWords > 300) {
  failures.push(`README.md: ${readmeWords} words is outside the required 180 to 300 word range.`);
}

const latestPath = path.join(root, 'evals/results/latest.json');
if (!fs.existsSync(latestPath)) {
  failures.push('evals/results/latest.json is missing.');
} else {
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  const expectedTests = latest.test_summary?.tests;

  const testCountMatches = readme.match(/\b\d+\s+tests\b/gi) || [];
  for (const match of testCountMatches) {
    const num = Number(match.match(/\d+/)[0]);
    if (expectedTests !== undefined && num !== expectedTests) {
      failures.push(
        `README.md contains literal test count "${match}" that does not match `
        + `evals/results/latest.json (${expectedTests}).`
      );
    }
  }

  if (expectedTests !== undefined && !design.includes(`${expectedTests} tests`)) {
    failures.push(`DESIGN.md must cite offline test count "${expectedTests} tests" from evals/results/latest.json.`);
  }
}

const liveLatestPath = path.join(root, 'evals/results/live-latest.json');
if (fs.existsSync(liveLatestPath)) {
  const liveLatest = JSON.parse(fs.readFileSync(liveLatestPath, 'utf8'));
  const quotes = liveLatest.citationFaithfulness?.totalQuotes;
  if (quotes && !design.includes(`${quotes}/${quotes} quotes`)) {
    failures.push(`DESIGN.md must cite citation faithfulness "${quotes}/${quotes} quotes" from live-latest.json.`);
  }

  const expectedBuildId = liveLatest.build_id || liveLatest.environment?.build_id;
  if (expectedBuildId) {
    const buildIdRegex = /\bbuild(?:\s+id)?[:\s]+`?([a-f0-9]{12})`?/gi;
    for (const [docName, docText] of contentByFile.entries()) {
      for (const match of docText.matchAll(buildIdRegex)) {
        if (match[1] !== expectedBuildId) {
          failures.push(
            `${docName} cites build id "${match[1]}" that does not match `
            + `live-latest.json (${expectedBuildId}).`
          );
        }
      }
    }
  }
}

if (!design.includes('20 requests per session')) {
  failures.push('DESIGN.md must state session quota of 20 requests per session.');
}
if (!design.includes('200 requests per day')) {
  failures.push('DESIGN.md must state global daily quota of 200 requests per day.');
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Documentation check passed for ${documents.length} files; `
    + `DESIGN.md is ${designWords} words; README.md is ${readmeWords} words.\n`
  );
}
