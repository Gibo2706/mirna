// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { sanitizeWranglerLog, safeHealthPayload, monitorWorker } from './sync-e2e-diagnostics.mjs';

describe('sync E2E worker lifecycle', () => {
  const setup = () => {
    const worker = new EventEmitter();
    worker.pid = 123;
    worker.kill = vi.fn();
    const saveStatus = vi.fn();
    const fail = vi.fn();
    const publishLog = vi.fn();
    const stop = monitorWorker(worker, { saveStatus, fail, publishLog });
    return { worker, saveStatus, fail, publishLog, stop };
  };
  it.each([
    [0, null],
    [1, null],
    [null, 'SIGSEGV'],
  ])('fails on unexpected exit %s / %s, including exit zero', (code, signal) => {
    const state = setup();
    state.worker.emit('exit', code, signal);
    expect(state.fail).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Sync E2E Worker exited unexpectedly'),
    );
    expect(state.saveStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'exited', code, signal }),
    );
    expect(state.publishLog).toHaveBeenCalledOnce();
    expect(state.worker.kill).not.toHaveBeenCalled();
  });
  it('handles spawn errors without exposing the raw error or restarting', () => {
    const state = setup();
    state.worker.emit('error', new Error('secret-canary'));
    expect(state.fail).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Sync E2E Worker exited unexpectedly'),
    );
    expect(JSON.stringify(state.fail.mock.calls)).not.toContain('secret-canary');
  });
  it('forwards teardown once and does not classify it as an infrastructure failure', () => {
    const state = setup();
    state.stop('SIGTERM');
    state.stop('SIGTERM');
    state.worker.emit('exit', null, 'SIGTERM');
    expect(state.worker.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(state.fail).not.toHaveBeenCalled();
    expect(state.saveStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'stopped' }),
    );
  });
});

describe('sync E2E artifact privacy', () => {
  it('retains known infrastructure causes without copying raw diagnostic values', () => {
    const raw = `--- 2026-09-18T14:00:00.000Z debug
Error in ProxyController: Error inside ProxyWorker
 cause: { message: 'Network connection lost.', token: 'secret-canary' }
Authorization: Bearer secret-canary
TURNSTILE_SECRET_KEY=secret-canary
{ recoveryCode: 'recovery-canary', ciphertext: 'ciphertext-canary' }
✘ [ERROR] e = workerd/util/sqlite.c++:1671: database is locked: SQLITE_BUSY
Error: unexpected recovery-canary
`;
    const sanitized = sanitizeWranglerLog(raw);
    expect(sanitized).toContain('Error inside ProxyWorker');
    expect(sanitized).toContain('Network connection lost.');
    expect(sanitized).toContain('SQLITE_BUSY');
    expect(sanitized).not.toMatch(/secret-canary|recovery-canary|ciphertext-canary|Bearer/u);
  });

  it('does not emit arbitrary messages, headers, URLs, IDs or payloads', () => {
    const sanitized = sanitizeWranglerLog(`Error: https://example.com?token=private-value
 at privateFunction (private-file:5:10)
Error inside ProxyWorker private-value
{"secret":"private-value"}`);
    expect(sanitized).toContain('Error inside ProxyWorker');
    expect(sanitized).not.toContain('private');
  });

  it('projects health onto fixed public readiness fields only', () => {
    expect(
      safeHealthPayload({
        status: 'degraded',
        environment: 'local',
        protocolVersion: 1,
        services: { d1: 'ok', r2: 'ok', secret: 'canary' },
        readiness: { accountingState: 'faulted', secret: 'canary' },
        recovery: 'canary',
      }),
    ).toEqual({
      status: 'degraded',
      environment: 'local',
      protocolVersion: 1,
      services: { d1: 'ok', r2: 'ok' },
      readiness: { accountingState: 'faulted' },
    });
    expect(JSON.stringify(safeHealthPayload({ status: 'secret-canary' }))).not.toContain('canary');
  });
});
