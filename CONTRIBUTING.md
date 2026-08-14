# Contributing to TraceJVM

TraceJVM is pre-release software with a security-sensitive native and Worker
boundary. Small, reviewable changes with explicit tests land fastest.

Open an issue first for any large change to the API, the architecture, a runtime
profile, or the release format. Agreeing on the boundary is much cheaper than
reworking a finished pull request.

## Setting up

You need Node.js 22.15.0 or newer and pnpm 10.22.0.

```sh
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` runs the type checker and the contract tests. CI also runs
`pnpm build` and `pnpm verify:package`; run those yourself for anything that
changes what the package ships.

## Checklist for a pull request

1. `pnpm test` passes.
2. `pnpm build` and `pnpm verify:package` pass for package-facing changes.
3. `pnpm test:compiler-boundary` passes when you touch the compiler, the VM
   lifecycle, the Worker boundary, or runtime loading.
4. Bug fixes and security fixes come with a regression test.
5. Commits are atomic, and the pull request explains any compatibility or
   security tradeoff.

Never commit generated caches, downloaded toolchains, credentials, or private
deployment configuration.

## Building the runtime from source

You only need this if you change the compiler or the VM. The build is
reproducible and pinned to Eclipse Temurin/OpenJDK `23.0.2+7`, Emscripten
`4.0.2`, the b-jvm revision in `engine/UPSTREAM.md`, and the TeaVM-javac
revision in `compiler/teavm-javac/manifest.json`.

```sh
pnpm install --frozen-lockfile
pnpm bootstrap:toolchain -- --build
pnpm build
```

`bootstrap:toolchain` verifies the host JDK archive and the exact Emsdk Git
revision before installing Emscripten and running both native build recipes.
Pass `--root=/path/on/a/large/disk` to keep the toolchain outside the repository
cache. It prints the actual Emsdk and JDK locations it used; do not assume a
fixed cache path when running the lower-level build recipes directly.

`runtime/assets` and `.cache/teavm-javac/artifacts` are generated build inputs
and intentionally not committed. The derived, content-addressed
`runtime-release/` directory *is* committed with each release, so a clean
checkout, CI, and npm packaging all verify the same browser bytes. Verify the
two release surfaces independently:

```sh
pnpm build
pnpm verify:package
pnpm verify:runtime-assets
pnpm verify:teavm-javac
```

## Compatibility tests are not negotiable

The OpenJDK sources under `compatibility/` are copied byte-for-byte from the
pinned `jdk23u` revision and verified by SHA-256. The lane runs in real browser
Workers under cross-origin isolation:

```sh
pnpm sync:openjdk-tests
pnpm test:compatibility
```

Do not edit an upstream test to make TraceJVM pass. A failure is a VM gap, a
missing host capability, or an unsupported jtreg mode, and it gets classified as
one of those — never deleted. See
[compatibility/openjdk/README.md](compatibility/openjdk/README.md).

## Releasing

Regenerating `runtime-release/` is an explicit release operation. Commit the new
content-addressed directory and its manifest together, separately from source
changes.

```sh
pnpm prepare:runtime-release
pnpm prepare:package-runtime
pnpm release:check
npm publish
```

`prepare:runtime-release` writes `release.json`, the complete hosted-release
contract. `prepare:package-runtime` then writes the tracked npm manifest and
archive from those same verified bytes. Between them they record every payload
path, byte size, SHA-256 digest, SRI value, content type, cache policy, runtime
profile, and browser entrypoint. The content hash derives from the payload tree,
so identical inputs produce an identical prefix and descriptor, and an existing
archive is reused when no runtime byte changed. Preparation fails if the
corresponding OpenJDK and TeaVM-javac source archives are absent or do not match
their pinned checksums.

`pnpm release:check` is a clean-checkout verification path: it never rebuilds or
replaces the candidate it is checking. `pnpm materialize:package-runtime` is the
inverse of packaging — it verifies the committed archive and expands it into the
ignored build locations used by browser tests.

Publishing the immutable tree to object storage is optional, and TraceJVM itself
is independent of Cloudflare. This repository's tooling can upload to an
operator-selected R2 bucket with `wrangler`:

```sh
pnpm upload:runtime-release -- --bucket=your-runtime-bucket --dry-run
TRACEJVM_RUNTIME_BUCKET=your-runtime-bucket \
TRACEJVM_RUNTIME_PUBLIC_BASE_URL=https://assets.example.test \
TRACEJVM_RUNTIME_REQUEST_ORIGIN=https://app.example.test \
  pnpm deploy:runtime-release
```

The upload rebuilds and verifies the package and runtime assets first, so it
cannot quietly pair current source with stale `dist` output. Payload objects go
up first and `release.json` last, as the release commit marker.
`pnpm check:runtime-release` then downloads and hashes the published objects and
checks their response headers.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md).

## Licensing

By contributing, you agree that your contribution is licensed under the
repository's AGPL-3.0-only license.
