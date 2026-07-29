import { execFileSyncAllowingSandboxStatusZero } from './exec-file.mjs';
import {
  findContentViolations,
  findPathViolation,
  isTextCandidate,
} from './public-safety-rules.mjs';

const root = process.cwd();
const git = (args, options = {}) =>
  execFileSyncAllowingSandboxStatusZero('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
const errors = [];
const inspectedEntries = new Set();

if (commits.length === 0) {
  errors.push('repository has no reachable commit');
}

for (const commit of commits) {
  const shortCommit = commit.slice(0, 12);
  const message = git(['show', '-s', '--format=%B', commit]);
  for (const violation of findContentViolations('COMMIT_MESSAGE', message)) {
    errors.push(`${shortCommit}: commit message ${violation}`);
  }

  const entries = git(['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^\d+\s+blob\s+([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (!match) continue;
    const [, blob, file] = match;
    const pathViolation = findPathViolation(file);
    if (pathViolation) {
      errors.push(`${shortCommit}:${file}: ${pathViolation}`);
      continue;
    }

    const entryKey = `${blob}\0${file}`;
    if (inspectedEntries.has(entryKey) || !isTextCandidate(file)) continue;
    inspectedEntries.add(entryKey);
    const content = git(['cat-file', 'blob', blob]);
    for (const violation of findContentViolations(file, content)) {
      errors.push(`${shortCommit}:${file}: ${violation}`);
    }
  }
}

if (errors.length) {
  process.stderr.write(`Public history check failed (${errors.length}):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Public history check passed for ${commits.length} reachable commit(s) and ${inspectedEntries.size} text object path(s).\n`,
  );
}
