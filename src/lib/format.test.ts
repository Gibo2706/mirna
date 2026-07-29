import { describe, expect, it } from 'vitest';
import {
  formatBackupAgeMessage,
  formatByteSize,
  formatSignedRsd,
  parseIntegerInput,
} from './format';

describe('localized value formatting', () => {
  it('uses a human byte unit appropriate for the value', () => {
    expect(formatByteSize(500)).toBe('500 B');
    expect(formatByteSize(15.4 * 1024)).toBe('15,4 KB');
    expect(formatByteSize(2.1 * 1024 ** 2)).toBe('2,1 MB');
    expect(formatByteSize(10.2 * 1024 ** 3)).toBe('10,2 GB');
  });

  it('formats Serbian backup age without zero-day or incorrect singular copy', () => {
    expect(formatBackupAgeMessage(0)).toBe('Backup je svež — napravljen danas.');
    expect(formatBackupAgeMessage(1)).toBe('Backup je napravljen pre 1 dan.');
    expect(formatBackupAgeMessage(2)).toBe('Backup je svež — napravljen pre 2 dana.');
    expect(formatBackupAgeMessage(8)).toBe(
      'Poslednji backup je napravljen pre 8 dana. Vreme je za novu kopiju.',
    );
  });

  it('shows an explicit sign for positive ledger adjustments', () => {
    expect(formatSignedRsd(-9_260)).toBe('-9.260 RSD');
    expect(formatSignedRsd(2_000)).toBe('+2.000 RSD');
  });

  it('keeps integer input parsing stable', () => {
    expect(parseIntegerInput('-9.260 RSD')).toBe(-9_260);
  });
});
