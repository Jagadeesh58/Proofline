import fs from 'node:fs';
import path from 'node:path';

export const PATTERNS = [
  { name: 'numbered_stage', regex: /\b(part|step|phase|stage|task|milestone)\s*#?\d+\b/i },
  { name: 'word_stage', regex: /\b(part|step|phase)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i },
  { name: 'as_requested', regex: /\bas requested\b/i },
  { name: 'per_plan', regex: /\bper (the|your) (plan|prompt|instructions?)\b/i },
  { name: 'as_planned', regex: /\bas planned\b/i },
  {
    name: 'address_feedback',
    regex: /\b(address(es|ed|ing)?|incorporat(e[sd]?|ing)) (the )?(review|feedback|comments)\b/i,
  },
  { name: 'work_in_progress', regex: /\b(wip|todo|fixme)\b/i },
  { name: 'final_changes', regex: /\bfinal (changes|version|touches)\b/i },
  {
    name: 'promotional',
    regex: new RegExp([
      String.raw`(?:\b100%|\b(robust|seamless|comprehensive|leverage|guarantees?|cutting-edge|`,
      String.raw`powerful|flawless|bulletproof|world-class|state-of-the-art|zero-risk|`,
      String.raw`no model can|frequently)\b)`,
    ].join(''), 'i'),
  },
];

export const WORK_COMPLETE_PATTERN = /\b(completed?|finished)\b/i;

// Allowlist for legitimate state words or checker self-references
const SELF_FILES = new Set([
  'scripts/check-wording.mjs',
  'scripts/document-check.mjs',
  'scripts/wording-allowlist.json',
  'tests/check-wording.test.mjs',
]);

let allowlist = [];
const allowlistPath = path.resolve('scripts/wording-allowlist.json');
if (fs.existsSync(allowlistPath)) {
  try {
    allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  } catch {}
}

function isAllowed(filePath, lineText) {
  const norm = filePath.split(path.sep).join('/');
  return allowlist.some((entry) => norm.endsWith(entry.file) && lineText.includes(entry.pattern));
}

export function scanText(text, filePath = '') {
  const normPath = filePath.split(path.sep).join('/');
  if (SELF_FILES.has(normPath)) return [];

  const hits = [];
  const lines = text.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (isAllowed(filePath, line)) continue;
    for (const pat of PATTERNS) {
      const match = line.match(pat.regex);
      if (match) {
        hits.push({
          line: idx + 1,
          rule: pat.name,
          match: match[0],
          text: line.trim(),
        });
      }
    }

    // Check complete/finished when used describing work/meta rather than turn status
    const workMatch = line.match(WORK_COMPLETE_PATTERN);
    if (workMatch) {
      const isTurnState = /status\s*[:=]|['"](?:completed|finished)['"]|claims_status/i.test(line);
      const isEvent = /event === 'done'|completed_at/i.test(line);
      if (!isTurnState && !isEvent) {
        hits.push({
          line: idx + 1,
          rule: 'work_completion_wording',
          match: workMatch[0],
          text: line.trim(),
        });
      }
    }
  }

  return hits;
}

export function scanRepository(root = path.resolve('.')) {
  const targets = ['src', 'public', 'tests', 'scripts', 'evals/cases'];
  const singleFiles = ['README.md', 'DESIGN.md', 'package.json'];
  const allFiles = [];

  for (const dir of targets) {
    const full = path.join(root, dir);
    if (fs.existsSync(full)) {
      const walk = (p) => {
        for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
          const res = path.join(p, ent.name);
          if (ent.isDirectory()) walk(res);
          else if (!ent.name.endsWith('.png') && !ent.name.endsWith('.sqlite') && !ent.name.endsWith('.css')) {
            allFiles.push(res);
          }
        }
      };
      walk(full);
    }
  }

  for (const rel of singleFiles) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) allFiles.push(full);
  }

  const allHits = [];
  for (const file of allFiles) {
    const rel = path.relative(root, file);
    const content = fs.readFileSync(file, 'utf8');
    const hits = scanText(content, rel);
    for (const hit of hits) {
      allHits.push({ file: rel.split(path.sep).join('/'), ...hit });
    }
  }
  return allHits;
}

const isDirectEntry = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

if (isDirectEntry) {
  const hits = scanRepository();
  if (hits.length > 0) {
    process.stderr.write(`Wording check failed with ${hits.length} issue(s):\n`);
    for (const hit of hits) {
      process.stderr.write(`  ${hit.file}:${hit.line} [${hit.rule}] ${hit.match} -> "${hit.text}"\n`);
    }
    process.exit(1);
  } else {
    process.stdout.write('Wording check passed.\n');
  }
}
