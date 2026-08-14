# OpenJDK compatibility corpus

These files are copied byte-for-byte from the pinned OpenJDK 23 update
repository. Their original GPLv2 headers are preserved. `manifest.json`
records the exact upstream commit and SHA-256 of each source.

This directory is not intended to become a curated collection of only passing
tests. Expansion imports coherent upstream test families, records unsupported
jtreg capabilities explicitly, and reports every result. Runtime defects are
fixed in TraceJVM rather than editing the imported test.

Run `pnpm sync:openjdk-tests` to reproduce the checked-in sources, then
`pnpm test:compatibility` to execute them in the browser runtime.

`catalog.json` inventories the full `java/lang`, `java/util`, and `java/io`
source trees at the pinned revision. It separates direct-main candidates from
tests that need jtreg modes, helper libraries, native code, frameworks, or
manual interaction. This keeps the runnable lane from becoming a hand-picked
list of favorable tests. Rebuild it with `pnpm catalog:openjdk-tests`.

`pnpm test:openjdk-campaign` executes a deterministic hash-selected shard from
the direct-main candidates and writes every outcome to
`reports/openjdk-campaign.json`. The seed and size are configurable through
`CAMPAIGN_SEED` and `CAMPAIGN_LIMIT`. `CAMPAIGN_PATH` selects one exact catalog
path for a focused reproduction. Discovery campaigns do not hide failures;
once a shard becomes a release gate, set `CAMPAIGN_ENFORCE=1`.

Pinned Eclipse Temurin/OpenJDK `23.0.2+7` is the oracle. The v2 campaign
compiles each selected source with both compilers, compares emitted class-file
hashes, and compares deterministic observable output. Tests that identify
themselves as performance/stress tests, and tests that dump host properties,
remain self-verifying: timing, object identity, and environment text are not
expected to match between native execution and a browser VM. A test that
reports its internal deadline as incomplete is still classified as a timeout.

Failures are classified rather than collapsed into one compatibility number:

- `tracejvm-semantic-defect` means runnable Java behavior differs from the
  pinned native OpenJDK oracle;
- `missing-runtime-module` requires a Java module outside the selected image;
- `missing-native` reaches an OpenJDK native boundary not yet implemented;
- `unsupported-browser-capability` requires a capability absent from the
  selected browser;
- `test-infrastructure` means the source is not a standalone runnable test or
  the measurement failed;
- `timeout` did not finish inside the campaign deadline.

Every non-pass must have exactly one of these classifications. Missing modules,
missing natives, infrastructure gaps, and timeouts stay visible so expanding
the image or campaign machinery cannot be mistaken for repairing JVM
semantics. The supported release boundary is recorded separately in
`release-profile.json`.
