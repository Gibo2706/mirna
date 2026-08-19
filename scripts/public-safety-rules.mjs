import { extname, normalize, sep } from 'node:path';

const highRiskParts = new Set([
  '.private',
  '.vercel',
  'artifacts',
  'blob-report',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'screenshots',
  'test-results',
]);

const publicConfigTemplate =
  /(?:^|[/\\])(?:\.env|\.dev\.vars)\.(?:example|sample|template)$/i;

const privateConfigFile =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.dev\.vars)$/i;

const highRiskNames = [
  /\.(?:bak|backup|key|pem|p12|snapshot|tar|tar\.gz|tgz|zip)$/i,
  /(?:^|\/)finance-backup-[^/]+\.json$/i,
  /(?:^|\/)finance-transactions-[^/]+\.csv$/i,
  /(?:^|\/)mirna-chatgpt-[^/]+\.md$/i,
  /(?:^|\/)mirna-chat-summary-[^/]+\.md$/i,
  /(?:^|\/)(?:personal-)?finance-(?:export|snapshot)-[^/]+$/i,
];

const textExtensions = new Set([
  '',
  '.css',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.nvmrc',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.vercelignore',
  '.yaml',
  '.yml',
]);

const publicImageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const contentRules = [
  {
    label: 'absolute workstation path',
    pattern: /(?:\/(?:home|Users)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/,
  },
  {
    label: 'private key material',
    pattern: new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('')),
  },
  {
    label: 'provider credential value',
    pattern: /(?:^|[^A-Za-z0-9])(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{20,}/,
  },
  {
    label: 'credential embedded in URL',
    pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  },
  {
    label: 'assigned high-entropy secret',
    pattern:
      /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9+/_.-]{24,}/i,
  },
];

const codexMarker = ['\\bCo', 'dex\\b'].join('');
const privateDevelopmentMarker = new RegExp(
  [codexMarker, 'prompt history', 'request history', 'source of truth'].join('|'),
  'i',
);
const nonSyntheticTestDescription = new RegExp(
  ['real user', 'real snapshot', 'real transaction', "production user's finances"].join('|'),
  'i',
);

export function findPathViolation(file) {
  const normalized = normalize(file);
  const parts = normalized.split(sep);
  if (parts.some((part) => highRiskParts.has(part))) {
    return 'high-risk path must not be public';
  }

  if (
    privateConfigFile.test(file) &&
    !publicConfigTemplate.test(file)
  ) {
    return 'private environment or local configuration file must not be public';
  }

  if (highRiskNames.some((pattern) => pattern.test(file))) {
    return 'private export, secret, or archive filename must not be public';
  }
  if (/personalPlanFixture/i.test(file)) {
    return 'legacy personal fixture path must not be public';
  }
  if (
    publicImageExtensions.has(extname(file).toLowerCase()) &&
    !normalized.startsWith(`public${sep}`) &&
    !normalized.startsWith(`docs${sep}assets${sep}`)
  ) {
    return 'public image must live under public/ or docs/assets/';
  }
  return undefined;
}

export function isTextCandidate(file) {
  if (publicConfigTemplate.test(file)) return true;

  return textExtensions.has(extname(file).toLowerCase());
}

export function findContentViolations(file, content) {
  const violations = [];
  for (const rule of contentRules) {
    if (rule.pattern.test(content)) violations.push(`contains ${rule.label}`);
  }
  if (file.toLowerCase().endsWith('.md') && privateDevelopmentMarker.test(content)) {
    violations.push('contains an internal development-history marker');
  }
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file) && nonSyntheticTestDescription.test(content)) {
    violations.push('describes test financial data as real');
  }
  return violations;
}

export const SYNTHETIC_FIXTURE_MARKER =
  "Synthetic test data. Not based on any real person's financial records.";
