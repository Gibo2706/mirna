import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncAllowingSandboxStatusZero } from './exec-file.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..');
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const archiveName = `mirna-finansije-${metadata.version}.tar.gz`;
const destination = resolve(root, '..', archiveName);

execFileSync(process.execPath, [join(scriptDirectory, 'public-repo-check.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
execFileSyncAllowingSandboxStatusZero('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: root,
  stdio: 'ignore',
});
execFileSync(process.execPath, [join(scriptDirectory, 'public-history-check.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
const status = execFileSyncAllowingSandboxStatusZero(
  'git',
  ['status', '--porcelain', '--untracked-files=normal'],
  {
    cwd: root,
    encoding: 'utf8',
  },
);
if (status.trim()) {
  throw new Error('Source packaging requires a clean working tree.');
}
execFileSyncAllowingSandboxStatusZero(
  'git',
  [
    'archive',
    '--format=tar.gz',
    `--prefix=mirna-finansije-${metadata.version}/`,
    `--output=${destination}`,
    'HEAD',
  ],
  { cwd: root, stdio: 'inherit' },
);

process.stdout.write(`Safe source archive created outside the repository: ${destination}\n`);
