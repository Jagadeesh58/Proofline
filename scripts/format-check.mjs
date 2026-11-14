import fs from 'node:fs';
import path from 'node:path';

const write = process.argv.includes('--write');
const extensions = new Set(['.mjs', '.js', '.html', '.css', '.json', '.md', '.yml', '.yaml']);
const ignored = new Set(['node_modules', 'data', '.git']);
const whitespaceIssues = [];
const longLineIssues = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
    } else if (extensions.has(path.extname(entry.name))) {
      const before = fs.readFileSync(file, 'utf8');
      const lines = before.replace(/\r\n/g, '\n').split('\n');
      const after = lines
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .replace(/\n*$/, '\n');

      if (before !== after) {
        if (write) fs.writeFileSync(file, after);
        else whitespaceIssues.push(path.relative('.', file));
      }

      // Check max line length for source code files
      const ext = path.extname(entry.name);
      if (['.mjs', '.js'].includes(ext)) {
        const cleanLines = before.split(/\r?\n/);
        cleanLines.forEach((line, index) => {
          if (line.length > 120 && !line.includes('long-line-ignore')) {
            longLineIssues.push(`${path.relative('.', file)}:${index + 1} (${line.length} chars)`);
          }
        });
      }
    }
  }
}

for (const folder of ['src', 'scripts', 'public']) {
  if (fs.existsSync(folder)) walk(folder);
}

let failed = false;

if (!write && whitespaceIssues.length) {
  process.stderr.write(
    `Formatting normalisation needed in:\n${whitespaceIssues.join('\n')}\n`
    + 'Run npm run format to normalise whitespace and line endings.\n'
  );
  failed = true;
}

if (longLineIssues.length) {
  process.stderr.write(
    `Lines exceeding 120 characters found:\n${longLineIssues.join('\n')}\n`
    + 'Wrap lines to 120 characters or add a comment containing "long-line-ignore".\n'
  );
  failed = true;
}

if (failed) {
  process.exitCode = 1;
} else {
  process.stdout.write(write ? 'Whitespace and line endings normalised.\n' : 'Formatting checks passed.\n');
}
