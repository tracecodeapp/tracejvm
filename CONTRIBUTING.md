# Contributing to TraceJVM

TraceJVM is a pre-release browser JVM with a security-sensitive native and
Worker boundary. Small, reviewable changes with explicit tests are easiest to
land.

## Before opening a pull request

1. Open an issue before a large API, architecture, runtime-profile, or release
   format change.
2. Install Node.js 22 and pnpm 10.22.0.
3. Run `pnpm install --frozen-lockfile` and `pnpm test`.
4. Run `pnpm build` and `pnpm verify:package` for package-facing changes.
5. Add a regression test for bug and security fixes.

Use `pnpm test:compiler-boundary` when changing the compiler, VM lifecycle,
Worker boundary, or runtime loading. Runtime changes must be built from the
pinned inputs in `runtime/manifest.json`; follow the Distribution section in
`README.md` and commit the resulting manifest/archive separately from source
changes.

Do not commit generated caches, downloaded toolchains, credentials, or private
deployment configuration. Keep commits atomic and explain compatibility or
security tradeoffs in the pull request.

By contributing, you agree that your contribution is licensed under the
repository's AGPL-3.0-only license.
