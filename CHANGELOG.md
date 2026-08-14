# Changelog

This project follows semantic versioning while it remains pre-1.0. Dates and
release notes are published with GitHub and npm releases.

## Unreleased

- Verify every executable runtime asset against pinned SHA-256 metadata before
  use.
- Bound untrusted requests, output, archives, and native classfile parsing.
- Isolate scratch cleanup and host-descriptor capabilities by JVM context.
- Make runtime releases reproducible from pinned repository inputs.
