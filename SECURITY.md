# Security policy

## Supported versions

Security fixes target the latest stable Mirna 2.4.1 release. Upgrade older
builds before reporting a version-specific problem. Encrypted sync is
production-enabled but has not passed an independent security audit.

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
poisoning, credential exposure in repository or CI configuration, sync
authorization bypass, cryptographic downgrade or nonce/key reuse, manifest or
snapshot rollback/forks, device revocation failure, conflict-driven financial
corruption, plaintext leakage and incomplete cloud deletion.

Encrypted sync keeps protocol, cryptographic, fail-closed and local-first gates
even when production-enabled. Local and staging testing must use synthetic
financial records only. Do not probe Cloudflare resources or any deployment you
do not own or have explicit permission to test.

The staging exercise is implementation evidence only. Production currently
reuses the existing staging-named Worker/D1/R2 data plane; that legacy resource
name does not remove the independent review gate.

Production and development dependencies are reviewed separately. Breaking
automated upgrades are not applied without verifying application behavior.
