# QMOOSA Synthetics Tests (`@qmoosa/synthetics-tests`)

Multi-repository reality gates, invariant verification, and adversarial test harness for the QMOOSA Synthetics suite (Domain 1, Repositories 036–040).

## 3-Gate Supply-Chain & Reality Verification System

1. **Gate 1: Archive Integrity Verification**
   - Validates SHA-256 hashes of packaged tarballs (`packages/qmoosa-synthetics-*.tgz`) against `integrity-manifest.json`.
2. **Gate 2: Source Provenance & Ancestry**
   - Cryptographically establishes git HEAD commit alignment across protocol, engine, and sdk sibling repositories.
3. **Gate 3: Reproducible Hermetic Rebuild & Canonical Comparison**
   - Clones source repositories, rebuilds cleanly, compiles artifacts, and performs byte-for-byte derivation verification.

## Test Suites

- **Integration Suite**: End-to-end multi-repo staking, debt issuance, zero-slippage trading, dynamic debt pool tracking, and shortfall bad-debt accounting.
- **Negative Control Suite**: 9 adversarial attack vectors including undercollateralized issuance, invalid unstaking, forged signatures, nonce replay attacks, healthy staker liquidation defense, archive tampering, stale oracles, and unbounded price swings.
