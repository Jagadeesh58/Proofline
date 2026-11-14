import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const documents = ['README.md', 'DESIGN.md'];
const americanSpellings = new Set([
  'behavior', 'behaviors', 'behavioral', 'color', 'colors', 'colorful', 'center', 'centers',
  'centralized', 'centralize', 'customize', 'customized', 'customizing', 'prioritize', 'prioritized',
  'prioritizing', 'normalize', 'normalized', 'normalizing', 'organization', 'organizations',
  'organize', 'organized', 'organizing', 'analyze', 'analyzed', 'analyzing', 'catalog',
  'canceled', 'canceling', 'labeled', 'labeling', 'traveling', 'traveled', 'licensee',
]);
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
if (designWords < 1100 || designWords > 1300) {
  failures.push(`DESIGN.md: ${designWords} words is outside the required 1,100 to 1,300 word range.`);
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
