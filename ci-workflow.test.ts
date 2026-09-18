import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import ts from 'typescript';
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

  it('preserves every staging var when Wrangler overrides the build SHA', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'mirna-wrangler-vars-'));
    try {
      const configPath = resolve('services/sync-worker/wrangler.jsonc');
      const parsedConfig = ts.parseConfigFileTextToJson(
        configPath,
        readFileSync(configPath, 'utf8'),
      );
      expect(parsedConfig.error).toBeUndefined();
      const stagingVars = (
        parsedConfig.config as {
          env: { staging: { vars: Record<string, string> } };
        }
      ).env.staging.vars;
      const build = 'abcdef1234567890';
      const outfile = resolve(directory, 'worker-upload');
      // Exercise the installed, lockfile-pinned CLI and inspect its actual upload
      // metadata. Dry-run does not upload or provision resources; no credentials
      // or local env files are passed to the child process.
      const run = spawnSync(
        process.execPath,
        [
          resolve('node_modules/wrangler/bin/wrangler.js'),
          'deploy',
          '--dry-run',
          '--env',
          'staging',
          '--config',
          configPath,
          '--env-file',
          '/dev/null',
          '--var',
          `MIRNA_BUILD_COMMIT:${build}`,
          '--x-provision=false',
          '--x-auto-create=false',
          '--outfile',
          outfile,
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            PATH: process.env.PATH,
            XDG_CONFIG_HOME: directory,
            WRANGLER_LOG_PATH: resolve(directory, 'wrangler.log'),
            WRANGLER_SEND_METRICS: 'false',
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
            CI: 'true',
          },
        },
      );
      expect(run.status, run.stderr).toBe(0);
      const upload = readFileSync(outfile, 'utf8');
      const boundary = upload.slice(2, upload.indexOf('\r\n'));
      const form = await new Response(upload, {
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      }).formData();
      const metadataPart = form.get('metadata');
      if (typeof metadataPart !== 'string') throw new Error('Missing Wrangler upload metadata');
      const metadata = JSON.parse(metadataPart) as {
        bindings: { type: string; name: string; text: string }[];
      };
      const vars: Record<string, string> = Object.fromEntries(
        metadata.bindings
          .filter((binding: { type: string }) => binding.type === 'plain_text')
          .map((binding: { name: string; text: string }) => [binding.name, binding.text]),
      );
      expect(vars).toEqual({ ...stagingVars, MIRNA_BUILD_COMMIT: build });
      expect(vars.MIRNA_ALLOWED_ORIGINS.split(',')).toContain('https://mirna-finansije.vercel.app');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
