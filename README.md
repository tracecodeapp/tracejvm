# TraceJVM

TraceJVM runs real Java in a web browser. It pairs a genuine OpenJDK 23 `javac`
with a real JVM, both compiled to WebAssembly, so `.java` source becomes
ordinary classfiles and those classfiles actually execute. No server, no plugin,
and no translating Java into JavaScript — it all happens in the user's own tab.
It ships as one npm package containing the JavaScript API and the exact runtime
bytes it was released with. You serve those bytes yourself; there is no hosted
service and nothing phones home. Compiler and runner are deliberately separate
halves — the compiler cannot execute, the runner cannot read source — so a
program that crashes takes only its own runner with it. Files, processes,
terminals, and networking are interfaces you implement.

> TraceJVM is an independent project and is not affiliated with, sponsored by,
> or endorsed by Oracle Corporation or the OpenJDK project.

## What it can and cannot do

**It can** compile and run ordinary Java 23 programs: multi-file source trees,
packages, program arguments, system properties, captured stdout/stderr, JARs
placed on the classpath with an explicit main class, and classfiles you supply
directly. Behavior is checked against unmodified OpenJDK tests in Chromium,
Firefox, WebKit, and WebKit under iPad emulation.

**It cannot** offer full Java SE compatibility — the supported profile is
`core` (`java.base`), and gaps are measured rather than assumed. No preview
language features, no GUI, audio, or desktop stack, no JNI, no interactive
stdin. OS processes, unrestricted files, and unrestricted networking do not
exist in a browser tab: supply a host adapter or those calls fail loudly rather
than as silent no-ops. And TraceJVM is a library, not a multi-tenant sandbox —
authorization and Worker policy are yours. Full contract:
[docs/supported-profile.md](docs/supported-profile.md).

## Install

You need Node.js 22.15.0 or newer and a static origin you control. Java is *not*
required — only for rebuilding the runtime from source.

```sh
npm install @tracecode/tracejvm
```

## What using it looks like

Two objects do the work. `TraceJVMCompiler` turns source into classfiles;
`TraceJVMEngine` executes classfiles and always needs an explicit main class.

```ts
const compiled = await compiler.compile({ sources });

const result = await runner.run({
  program: compiled.program,
  mainClass: "example.Hello",
  args: ["world"],
});
```

First you expand the runtime archive onto your own origin and pin its manifest,
and real applications put both objects in Workers.
**[docs/getting-started.md](docs/getting-started.md) is the complete recipe** —
extraction, a working example, response headers, Worker topology. Start there.

## Status and safety

TraceJVM 0.4 is **pre-release**. Public APIs and runtime profiles may change
between minor releases. Compatibility is measured rather than claimed: known
gaps stay visible in the reports, and
[docs/release-readiness.md](docs/release-readiness.md) has the evidence and the
remaining blockers.

Two things to get right when you deploy. Build your asset integrity map from
the manifest inside the package, never one fetched at runtime: a manifest
served by the same mutable origin as the assets is not a trust anchor. And any
page supplying a host adapter must be cross-origin isolated, because the
synchronous host bridge uses a `SharedArrayBuffer`.

## Documentation

- [docs/getting-started.md](docs/getting-started.md) — self-hosting, compiling,
  running, Workers.
- [docs/supported-profile.md](docs/supported-profile.md) — the compatibility
  contract.
- [docs/architecture.md](docs/architecture.md) — boundaries, Effect surface,
  isolation internals.
- [docs/embedding.md](docs/embedding.md) — host adapters and TraceKernel.
- [docs/runtime-profiles.md](docs/runtime-profiles.md) — size and memory.
- [compatibility/openjdk/README.md](compatibility/openjdk/README.md) — how
  results are classified.
- [CONTRIBUTING.md](CONTRIBUTING.md) building · [SUPPORT.md](SUPPORT.md) asking
  · [SECURITY.md](SECURITY.md) reporting.

## License and attribution

TraceJVM's own code is licensed under **AGPL-3.0-only**; the full text is in
[LICENSE](LICENSE).

Redistributing the runtime carries obligations under several licenses. OpenJDK
/ Eclipse Temurin runtime images and the compiler built from OpenJDK sources
are GPLv2 with the Classpath Exception; [b-jvm](https://github.com/anematode/b-jvm),
which the runner derives from, is MIT; TeaVM-javac is Apache 2.0, with
TraceJVM's modifications recorded in `compiler/teavm-javac/NOTICE`; Effect is
MIT. The npm runtime archive carries the required license and notice files but
omits the much larger corresponding-source archives; those ship in the matching
complete hosted release described by `release.json`. Read
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[legal/CORRESPONDING_SOURCE.md](legal/CORRESPONDING_SOURCE.md) before
redistributing the runtime.
