import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, shareTextFile } from './backup';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('offline export capabilities', () => {
  it('shares a Markdown File through the native share sheet', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      canShare: vi.fn().mockReturnValue(true),
      share,
    });
    await expect(
      shareTextFile({
        filename: 'mirna.md',
        content: '# Mirna',
        type: 'text/markdown',
        title: 'Mirna',
      }),
    ).resolves.toBe('shared');
    const payload = share.mock.calls[0]?.[0] as { files: File[] };
    expect(payload.files[0]).toMatchObject({
      name: 'mirna.md',
      type: 'text/markdown',
    });
    const content = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('Očekivan je tekstualni sadržaj izvezene datoteke.'));
      };
      reader.onerror = () =>
        reject(reader.error ?? new Error('Izvezena datoteka nije mogla da se pročita.'));
      reader.readAsText(payload.files[0]);
    });
    expect(content).toBe('# Mirna');
  });

  it('reports unsupported file share so UI can download offline instead', async () => {
    vi.stubGlobal('navigator', {});
    await expect(
      shareTextFile({
        filename: 'mirna.md',
        content: '# Mirna',
        type: 'text/markdown',
        title: 'Mirna',
      }),
    ).resolves.toBe('unsupported');
  });

  it('copies the exact generated text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyText('# Mirna Financial Snapshot');
    expect(writeText).toHaveBeenCalledWith('# Mirna Financial Snapshot');
  });
});
