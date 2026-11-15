import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');
const releaseDir = path.join(root, 'release');
const zipPath = path.join(releaseDir, 'Proofline-public-release.zip');

fs.mkdirSync(releaseDir, { recursive: true });

const excludePatterns = [
  /^\.git(\\|\/|$)/,
  /^\.env(\..+)?$/,
  /^node_modules(\\|\/|$)/,
  /^data(\\|\/|$)/,
  /^release(\\|\/|$)/,
  /^\.eval-tmp(\\|\/|$)/,
  /^evals\/results\/scratch(\\|\/|$)/,
  /\.sqlite(-wal|-shm)?$/,
  /\.log$/,
  /\.tmp$/,
  /\.DS_Store$/,
  /Thumbs\.db$/,
];

function shouldInclude(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of excludePatterns) {
    if (pattern.test(normalized) || pattern.test(relPath)) return false;
  }
  return true;
}

function collectFiles(dir, base = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = base ? path.join(base, entry.name) : entry.name;
    if (!shouldInclude(relPath)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      files.push({ relPath, fullPath });
    }
  }
  return files;
}

const filesToPackage = collectFiles(root);
process.stdout.write(`Found ${filesToPackage.length} files to package into release.\n`);

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofline-staging-'));
try {
  for (const { relPath, fullPath } of filesToPackage) {
    const dest = path.join(stagingDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(fullPath, dest);
  }

  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  process.stdout.write(`Compressing to ${zipPath}...\n`);
  const psCommand = `Compress-Archive -Path "${stagingDir}\\*" -DestinationPath "${zipPath}" -Force`;
  const zipResult = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8' });
  if (zipResult.status !== 0) {
    throw new Error(`Compress-Archive failed: ${zipResult.stderr}`);
  }

  const stat = fs.statSync(zipPath);
  process.stdout.write(`Release archive created: ${(stat.size / 1024).toFixed(1)} KB.\n`);

  process.stdout.write('Testing extraction and verification of release package...\n');
  const testExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofline-test-extract-'));
  try {
    const extractCmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${testExtractDir}" -Force`;
    const extractResult = spawnSync('powershell', ['-NoProfile', '-Command', extractCmd], { encoding: 'utf8' });
    if (extractResult.status !== 0) {
      throw new Error(`Expand-Archive failed: ${extractResult.stderr}`);
    }

    process.stdout.write('Running npm run check in extracted release directory...\n');
    const checkResult = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check'], {
      cwd: testExtractDir,
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, DB_PATH: ':memory:' },
    });
    if (checkResult.status !== 0) {
      if (checkResult.stdout) process.stdout.write(checkResult.stdout);
      if (checkResult.stderr) process.stderr.write(checkResult.stderr);
      if (checkResult.error) process.stderr.write(`Spawn error: ${checkResult.error}\n`);
      throw new Error(`Extracted release package failed npm run check (status: ${checkResult.status})`);
    }
    process.stdout.write('Extracted release package verified successfully!\n');
  } finally {
    fs.rmSync(testExtractDir, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
