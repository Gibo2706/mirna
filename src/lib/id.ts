export const createId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
