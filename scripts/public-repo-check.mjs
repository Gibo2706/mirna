import { existsSync, readFileSync } from 'node:fs';
import { execFileSyncAllowingSandboxStatusZero } from './exec-file.mjs';
import {
  findContentViolations,
  findPathViolation,
  isTextCandidate,
  SYNTHETIC_FIXTURE_MARKER,
} from './public-safety-rules.mjs';

const root = process.cwd();
const output = execFileSyncAllowingSandboxStatusZero(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    cwd: root,
    encoding: 'utf8',
  },
);
const files = [...new Set(output.split('\0').filter((file) => file && existsSync(file)))].sort();
const errors = [];

for (const file of files) {
  const pathViolation = findPathViolation(file);
  if (pathViolation) {
    errors.push(`${file}: ${pathViolation}`);
    continue;
  }
  if (!isTextCandidate(file)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    errors.push(`${file}: candidate file could not be read`);
    continue;
  }
  for (const violation of findContentViolations(file, content)) {
    errors.push(`${file}: ${violation}`);
  }
}

const fixtureFiles = files.filter((file) => file.startsWith('src/tests/fixtures/'));
if (fixtureFiles.length === 0) {
  errors.push('src/tests/fixtures/: at least one synthetic regression fixture is required');
}
for (const fixtureFile of fixtureFiles.filter(isTextCandidate)) {
  if (!readFileSync(fixtureFile, 'utf8').includes(SYNTHETIC_FIXTURE_MARKER)) {
    errors.push(`${fixtureFile}: required synthetic-data marker is missing`);
  }
}

if (errors.length) {
  process.stderr.write(`Public repository check failed (${errors.length}):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public repository check passed for ${files.length} candidate files.\n`);
}
