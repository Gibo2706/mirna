import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const deployJob = workflow.slice(workflow.indexOf('  deploy-sync-worker:'));

describe('sync Worker deployment workflow', () => {
  it('deploys only a tested main push and never a pull request or feature branch', () => {
    expect(deployJob).toContain('needs: [quality, e2e]');
    expect(deployJob).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(deployJob).toContain('environment: production-sync');
  });

  it('serializes migrations and deployment without cancelling an active release', () => {
    expect(deployJob).toContain('group: mirna-production-sync-deploy');
    expect(deployJob).toContain('cancel-in-progress: false');
    expect(deployJob.indexOf('Apply pending D1 migrations')).toBeLessThan(
      deployJob.indexOf('Deploy existing Worker'),
    );
    expect(deployJob.indexOf('Deploy existing Worker')).toBeLessThan(
      deployJob.indexOf('Verify deployed build and service readiness'),
    );
    expect(deployJob).toContain('--x-provision=false --x-auto-create=false');
  });

  it('uses only GitHub Environment secrets and verifies the exact main commit', () => {
    expect(deployJob).toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(deployJob).toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
    expect(deployJob).not.toContain('TURNSTILE_SECRET_KEY');
    expect(deployJob).toContain('--var MIRNA_BUILD_COMMIT:${GITHUB_SHA}');
    expect(deployJob).toContain('--expected-build "${GITHUB_SHA}"');
  });
});
