import { execFileSync } from 'node:child_process';

export function execFileSyncAllowingSandboxStatusZero(file, args, options = {}) {
  try {
    return execFileSync(file, args, options);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      error.status === 0 &&
      'stdout' in error
    ) {
      return error.stdout;
    }
    throw error;
  }
}
