# Security policy

## Supported versions

Security fixes target the latest published 2.3.x release. Upgrade older builds
before reporting a version-specific problem.

## Reporting a vulnerability

Once the public repository exists and GitHub Private Vulnerability Reporting is
enabled, open the
[Mirna Security page](https://github.com/Gibo2706/mirna/security) and use
**Advisories → Report a vulnerability**.

If that option is unavailable, do not publish details. Open a
[detail-free issue](https://github.com/Gibo2706/mirna/issues) asking the project
maintainer to enable private vulnerability reporting.
Reports are reviewed as soon as practical.

Do not attach financial backups, screenshots, access tokens, or other private
data. Replace sensitive values with synthetic examples and include:

- affected version and browser;
- concise reproduction steps;
- expected and observed security boundary;
- potential impact;
- a suggested fix, if available.

Do not test data or systems without ownership or explicit permission.

## Scope

Important areas include local data disclosure, unsafe backup import,
financial-integrity bypasses, arbitrary script execution, service-worker cache
poisoning, and credential exposure in repository or CI configuration.

Production and development dependencies are reviewed separately. Breaking
automated upgrades are not applied without verifying application behavior.
