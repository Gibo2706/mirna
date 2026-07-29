export const formatRsd = (value: number): string =>
  `${new Intl.NumberFormat('sr-Latn-RS', {
    maximumFractionDigits: 0,
  }).format(value)} RSD`;

export const formatSignedRsd = (value: number): string =>
  `${value > 0 ? '+' : ''}${formatRsd(value)}`;

export const formatCompactRsd = (value: number): string =>
  new Intl.NumberFormat('sr-Latn-RS', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export const formatByteSize = (value: number): string => {
  let size = Math.max(0, value);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat('sr-Latn-RS', {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(size)} ${BYTE_UNITS[unitIndex]}`;
};

export const formatBackupAgeMessage = (daysSinceBackup: number): string => {
  const days = Math.max(0, Math.floor(daysSinceBackup));
  if (days === 0) return 'Backup je svež — napravljen danas.';
  if (days === 1) return 'Backup je napravljen pre 1 dan.';
  if (days <= 7) return `Backup je svež — napravljen pre ${days} dana.`;
  return `Poslednji backup je napravljen pre ${days} dana. Vreme je za novu kopiju.`;
};

export const parseIntegerInput = (value: string): number => {
  const normalized = value.replace(/[^\d-]/g, '');
  return normalized === '' || normalized === '-' ? 0 : Number.parseInt(normalized, 10);
};
