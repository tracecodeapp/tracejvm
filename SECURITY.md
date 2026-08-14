# Security Policy

## Reporting

Report suspected vulnerabilities through GitHub private vulnerability
reporting. Do not open a public issue containing vulnerability details.

## Supported Versions

Security fixes target the latest pre-release version and its immutable runtime
release.

## System and Scope

TraceJVM compiles and runs attacker-controlled Java source, classfiles, JARs,
arguments, and process files inside browser Workers. Covered surfaces include
native parsers, virtual filesystem cleanup, compiler/runner separation, host
channels, descriptor capabilities, release tooling, and executable assets.

## Threat Model and Security Invariants

- Java inputs, archives, paths, host requests, manifests, and remote assets may
  be attacker-controlled.
- Parsing, decompression, input, output, and host-call resource use must remain
  bounded.
- Runtime and TraceKernel files must not be overwritten through path aliases or
  cleanup traversal.
- Host descriptors and asynchronous calls must remain bound to their originating
  JVM context.
- Executable JavaScript, Wasm, and runtime archives must match pinned size and
  SHA-256 metadata before use.
- Worker disposal must remain the hard failure and cancellation boundary.

## Out of Scope and Known Limitations

TraceJVM is a library, not a complete multi-tenant security sandbox. Embedders
own host-adapter authorization, browser headers, Worker retirement, and
self-hosted asset delivery. The asset manifest is a trust anchor and must be
obtained through a trusted package or deployment channel. Java compatibility
defects without a security-boundary impact are ordinary bugs.
