import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts', 'tests', 'evals', 'public'];
const extensions = new Set(['.mjs', '.js', '.html', '.css']);
const banned = [/\bTODO\b/, /\bFIXME\b/, /\bHACK\b/, /console\.(?:log|debug)\s*\(/];
const commentedCode = new RegExp(
  '^\\s*\\/\\/\\s*(?:const\\s|let\\s|var\\s|return\\b|await\\b|if\\s*\\(|'
  + 'for\\s*\\(|while\\s*\\(|import\\s|export\\s|console\\.|fetch\\s*\\(|process\\.|document\\.|store\\.)'
);
const failures = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (extensions.has(path.extname(entry.name))) {
      const content = fs.readFileSync(file, 'utf8');
      content.split(/\r?\n/).forEach((line, index) => {
        if (/[ \t]+$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`);
        if (commentedCode.test(line)) failures.push(`${file}:${index + 1}: commented-out code`);
        for (const pattern of banned) {
          if (pattern.test(line)) failures.push(`${file}:${index + 1}: forbidden marker or debug log`);
        }
      });
    }
  }
}

for (const root of roots) if (fs.existsSync(root)) walk(root);
if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Lint checks passed.\n');
}
