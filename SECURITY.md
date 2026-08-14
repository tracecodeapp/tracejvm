# Security Policy

## Reporting a vulnerability

Use GitHub's [private vulnerability
reporting](https://github.com/tracecodeapp/tracejvm/security/advisories/new).
Do not open a public issue containing vulnerability details.

## Supported versions

Security fixes target the latest pre-release version and its immutable runtime
release.

## What is in scope

TraceJVM compiles and runs attacker-controlled Java source, classfiles, JARs,
arguments, and process files inside browser Workers. In scope: native parsers,
virtual filesystem cleanup, compiler/runner separation, host channels,
descriptor capabilities, release tooling, and executable assets.

## Threat model and invariants

Assume Java inputs, archives, paths, host requests, manifests, and remote assets
may all be attacker-controlled. The following must hold:

- Parsing, decompression, input, output, and host-call resource use stay
  bounded.
- Runtime and TraceKernel files cannot be overwritten through path aliases or
  cleanup traversal.
- Host descriptors and asynchronous calls stay bound to the JVM context that
  originated them.
- Executable JavaScript, Wasm, and runtime archives match their pinned size and
  SHA-256 before use.
- Worker disposal remains the hard failure and cancellation boundary.

A report that breaks one of these invariants is a security issue.

## What is out of scope

TraceJVM is a library, not a complete multi-tenant security sandbox. As the
embedder, you own host-adapter authorization, browser response headers, Worker
retirement, and delivery of your self-hosted assets.

The asset manifest is a trust anchor, so it must reach you through a trusted
package or deployment channel. Fetching it from the same mutable origin that
serves the assets defeats the purpose, and is not a TraceJVM vulnerability.

Java compatibility defects with no security-boundary impact are ordinary bugs.
Report those as issues.
