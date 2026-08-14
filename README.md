# TraceJVM

TraceJVM is a browser-native Java 23 toolchain. Version 0.4 has two deliberately
separate components: a persistent OpenJDK `javac` compiled ahead of time with
TeaVM Wasm GC, and disposable TraceJVM runners that execute ordinary
classfiles through `main(String[])`.

**TraceJVM is an independent project and is not affiliated with, sponsored by,
or endorsed by Oracle Corporation or the OpenJDK project.**

The runner is derived from a pinned
[b-jvm](https://github.com/anematode/b-jvm) engine snapshot. b-jvm provides the
JDK 23-capable WebAssembly VM foundation. The compiler consumes the pinned
[TeaVM-javac](https://github.com/konsoletyper/teavm-javac) source and the exact
OpenJDK 23.0.2+7 `javac` sources through a reproducible downstream overlay.
TraceJVM defines lifecycle and isolation guarantees, exposes host-neutral
embedding interfaces, and validates its supported profile against OpenJDK
across release browsers.

- `TraceJVMCompiler` owns source-to-classfile compilation only. It has no Java
  VM, process, filesystem, or TraceKernel authority.
- `TraceJVMEngine` owns class loading and execution only. It contains no
  compiler and cannot accept Java source.
- `TraceJVMCompilerWorkerClient` keeps compilation warm in a compiler-only
  Worker. `TraceJVMWorkerClient` owns one independently disposable runner.
- `TraceJVMRunnerHost` may share the immutable JDK/Wasm substrate across
  disposable runner JVMs. It has no compiler or source API.
- Embedders own their invocation protocols and integrations for processes,
  filesystems, environments, terminals, and other host facilities.
- Instrumentation, probe protocols, event transport, and reconstruction stay
  outside the VM. TraceJVM executes the resulting ordinary Java bytecode.
- Host capabilities are explicit interfaces. TraceJVM does not import a
  consumer package, assume a CDN route, or contain a product request shape.

## Status

TraceJVM 0.4 is pre-release. Compatibility is intentionally measured rather
than assumed. The OpenJDK compatibility lane is the authority for Java
behavior, and known gaps stay visible until the runner implements them.

## API

There is intentionally no combined engine role in 0.4. An embedder that wants
compile-then-run composes the compiler and runner explicitly:

```ts
import {
  createTraceJVMAssetIntegrityMap,
  TraceJVMCompiler,
  TraceJVMEngine,
} from "@tracecode/tracejvm";
import pinnedReleaseManifest from "./tracejvm-runtime-manifest.json";

const releaseBaseUrl = "/tracejvm";
const integrity = createTraceJVMAssetIntegrityMap(
  releaseBaseUrl,
  pinnedReleaseManifest.files,
);
const runtimeAssets = {
  runtimeProfileBaseUrls: {
    core: `${releaseBaseUrl}/profiles/core`,
  },
  wasmUrl: `${releaseBaseUrl}/bjvm_main.wasm`,
  integrity,
};

const compiler = new TraceJVMCompiler({
  assets: {
    baseUrl: `${releaseBaseUrl}/compiler`,
    integrity,
  },
  platformArchiveUrl: `${releaseBaseUrl}/profiles/core/jdk23.jar`,
});
const runner = new TraceJVMEngine({
  assets: runtimeAssets,
});

await Promise.all([compiler.initialize(), runner.initialize()]);
const compiled = await compiler.compile({
  sources: [{
    path: "example/Hello.java",
    content: `
      package example;
      public final class Hello {
        public static void main(String[] args) {
          System.out.println("hello " + args[0]);
        }
      }
    `,
  }],
});
if (compiled.status !== "completed" || !compiled.program) {
  throw new Error(compiled.stderr);
}
const result = await runner.run({
  program: compiled.program,
  mainClass: "example.Hello",
  args: ["world"],
});
```

The compiler, engine, and runner Worker client also expose typed
[Effect](https://effect.website/) operations. Infrastructure failures use the
Effect error channel; compiler diagnostics and uncaught Java exceptions remain
normal result data.

For an application topology, keep one `TraceJVMCompilerWorkerClient` warm and
construct a `TraceJVMWorkerClient` for each admitted runner lifetime. The
compiler Worker has no VM or process authority; terminating a runner never
discards the compiler and a runner crash cannot poison it. The embedder remains
authoritative for process admission, files, descriptors, signals, and
networking.

When the compiler and runner lifecycle already live inside one provider Worker,
pair `TraceJVMCompiler` with `TraceJVMRunnerHost` instead. The runner host
amortizes immutable JDK/Wasm loading while every `createProcess()` call still
receives a fresh disposable JVM. TraceJVM does not combine the two components;
the embedder owns that composition.

```ts
const compiler = new TraceJVMCompilerWorkerClient({
  compiler: {
    assets: {
      baseUrl: "/tracejvm/compiler",
      integrity,
    },
    platformArchiveUrl: "/tracejvm/profiles/core/jdk23.jar",
    platformClasspath: [{
      path: "tracekernel-api.jar",
      url: "/tracejvm/profiles/core/tracekernel-api.jar",
    }],
  },
  createWorker: createCompilerWorker,
});
await compiler.initialize();
const compiled = await compiler.compile({
  sources: [{ path: "Main.java", content: source }],
});
const runner = new TraceJVMWorkerClient({
  engine: {
    assets: runtimeAssets,
    workingDirectory: "/workspace",
  },
  host: processBoundTraceKernelPort,
  createWorker: createRunnerWorker,
});
const result = await runner.run({
  program: compiled.program!,
  mainClass: "Main",
});
runner.terminate();
```

For a standalone isolated runner, use `TraceJVMWorkerClient` with the exported
browser Worker.
Terminating the Worker is the hard disposal boundary, so the client uses hard
Worker termination for aborts by default. Normal executions reuse the warm VM
only after the Java execution scope restores its covered process state. Every
run exposes an `isolation` report. If a scope cannot prove safe reuse, including
after application thread creation, it returns `status: "tainted"` and recommends
retirement. The default Worker client closes that idle Worker automatically.
It also retires after a configurable maximum number of executions.

```ts
import {
  TraceJVMWorkerClient,
  type TraceJVMWorkerLike,
} from "@tracecode/tracejvm";

const java = new TraceJVMWorkerClient({
  engine: {
    assets: runtimeAssets,
  },
  createWorker: () =>
    new Worker("/tracejvm/browser-worker.js", {
      type: "module",
    }) as unknown as TraceJVMWorkerLike,
});

const result = await java.run({
  program: compiled.program,
  mainClass: "example.Hello",
});
```

TraceJVM intentionally does not provide a combined compiler/runner host.
Embedders that want a different lifecycle compose the two Worker clients
without giving either component authority over the other.

### Resource safety

Compiler and runner requests are rejected before Worker transfer when they
exceed the exported `TRACEJVM_DEFAULT_RESOURCE_LIMITS`: 4,096 payload entries,
128 MiB aggregate input, 64 MiB per file or string entry, and 4 MiB combined
stdout/stderr or compiler diagnostics. Generated classfiles are checked against
the same input ceilings before they leave the compiler. Pass a partial `limits`
object to `TraceJVMCompilerOptions`, `TraceJVMOptions`, or
`TraceJVMRunnerHostOptions` to select stricter host policy; Worker clients use
the limits nested in their compiler or engine options. The native JAR loader
also rejects malformed ZIP bounds and archive expansion beyond its fixed VM
safety ceilings.

### Optional host controls

Hosted Java programs use ordinary Java APIs for files, descriptors, child
processes, sockets, selectors, and watch services. Operations without a Java SE
equivalent are exposed by the small runtime API:

```java
import io.tracecode.tracekernel.TraceKernel;
import java.time.Duration;

var identity = TraceKernel.currentProcess();
var armed = TraceKernel.armWatchdog(
    Duration.ofSeconds(5),
    TraceKernel.WatchdogSignal.SIGKILL);
TraceKernel.petWatchdog();
TraceKernel.disarmWatchdog();

TraceKernel.setProcessGroup(0, 0); // setpgid(0, 0)
long foreground = TraceKernel.terminalForegroundProcessGroup(0);
TraceKernel.setTerminalForegroundProcessGroup(0, foreground);
```

The API is compiled into a standalone `tracekernel-api.jar`; it is not patched
into `java.base` and does not add a product dependency to TraceJVM. Its native
methods use the same generic host port as the standard Java adapters. A
standalone engine without the corresponding host capability fails these calls
with `IOException` instead of emulating process control locally.

## Build

The runtime build is reproducible and pinned:

- Eclipse Temurin/OpenJDK `23.0.2+7`
- Emscripten `4.0.2`
- the b-jvm upstream revision recorded in `engine/UPSTREAM.md`
- the TeaVM-javac revision recorded in `compiler/teavm-javac/manifest.json`

```sh
pnpm install --frozen-lockfile
pnpm bootstrap:toolchain -- --build
pnpm build
```

The bootstrap command verifies the host JDK archive and exact Emsdk Git
revision before installing Emscripten and running both native build recipes.
Use `--root=/path/on/a/large/disk` when the toolchain should live outside the
repository cache. The equivalent manual sequence is:

```sh
pnpm install
source .cache/emsdk/emsdk_env.sh
pnpm build:runtime
TRACEJVM_JAVA23_HOME=/path/to/jdk-23 pnpm build:teavm-javac
pnpm build
```

`runtime/assets` and `.cache/teavm-javac/artifacts` are generated build inputs
and intentionally not committed. The derived, content-addressed
`runtime-release/` package directory is committed with each TraceJVM release,
so a clean checkout, CI, and npm packaging all verify the same browser bytes.

The npm package owns both the TraceJVM API and the exact browser runtime it was
released with. That runtime includes the OpenJDK images, TeaVM compiler,
`tracekernel-api.jar`, `bjvm_main.wasm`, browser client, browser Worker, and a
generated byte ledger. The runtime travels as one verified Zstandard archive
so the public npm artifact stays below the registry size limit; the exported
`@tracecode/tracejvm/runtime-package` helper expands it for serving. An
embedder may install that immutable tree at its own static origin, but it must
not substitute independently versioned JVM assets.
Release preparation reuses an existing archive whenever the generated file
inventory and digests are unchanged, and rebuilds it when any runtime byte
changes.
TraceJVM still accepts explicit URLs so an embedder can choose where to serve
the tree without choosing its contents.

Verify the two release surfaces independently:

```sh
pnpm build
pnpm verify:package
pnpm verify:runtime-assets
pnpm verify:teavm-javac
```

## Distribution

TraceJVM has one versioned package with two representations of the same
release:

- `@tracecode/tracejvm` contains the host-neutral API, browser client, browser
  Worker, a content-addressed runtime archive, its exact expanded-file
  manifest, and the complete license and notice material for those bytes.
  Consumers use the package's runtime helper directly or through their own
  integration layer to
  verify and expand the archive before serving it.
- The optional hosted runtime release contains the same TeaVM-javac module,
  WebAssembly VM, and
  Java 23 runtime profiles. Its `legal/` directory carries TraceJVM's
  third-party notices, the complete applicable Temurin/OpenJDK legal material,
  the b-jvm MIT license, and TeaVM-javac's Apache 2.0 license and downstream
  modification notice. Its `source/` directory carries the exact corresponding
  OpenJDK and TeaVM-javac sources plus TraceJVM's manifests, patches, and build
  scripts. Runtime release preparation fails if those source archives are
  absent or do not match their pinned checksums.
  When published to object storage it lives below
  `tracejvm/<package-version>/<content-hash>/` and is never addressed through a
  mutable `latest` alias.

Prepare a runtime release with:

```sh
pnpm prepare:runtime-release
```

The generated `release.json` is the engine release contract. The npm package
also contains `runtime-release/manifest.json`, which declares the compressed
archive, its exact browser-serving and legal inventory, and its installation
path; the large exact corresponding-source archives remain in the immutable
hosted release. Together
they record every
payload path, byte size, SHA-256 digest, SRI value, content type, cache policy,
runtime profile, and browser entrypoint. The content hash is derived from the
payload tree, so rerunning the command for identical inputs produces the same
prefix and descriptor.

Regenerating `runtime-release/` is an explicit release operation. Commit the
new content-addressed directory and manifest together. Ordinary `prepack`
verifies that tracked inventory and never substitutes an ignored local cache.
`pnpm materialize:package-runtime` performs the inverse operation: it verifies
the committed archive and expands its runtime and compiler trees into the
ignored build locations used by browser tests. This makes `pnpm release:check`
a clean-checkout verification path; it never rebuilds or replaces the release
candidate being checked.

The asset origin is part of the browser security boundary, not merely file
storage. It must serve every release object with CORS, cross-origin resource
policy, MIME hardening, and immutable caching exactly as recorded in
`release.json`. The module Worker additionally requires cross-origin embedder
policy and the descriptor's Worker CSP. `pnpm check:runtime-release` verifies
those headers as well as the bytes; uploading objects without the response
policy is not a completed release.

Every compiler, Wasm, JAR, and runtime file is verified against the caller's
pinned size and SHA-256 before TraceJVM executes or installs it. Build the
integrity map from the package's committed runtime manifest or another
deployment-pinned copy. Fetching an unpinned manifest from the same mutable
asset origin is not a trust anchor: an origin compromise could replace the
manifest and payload together.

TraceJVM itself remains independent of Cloudflare. As an optional deployment
adapter, this repository's release tooling can publish to an operator-selected
R2 bucket:

```sh
pnpm upload:runtime-release -- --bucket=your-runtime-bucket --dry-run
TRACEJVM_RUNTIME_BUCKET=your-runtime-bucket \
TRACEJVM_RUNTIME_PUBLIC_BASE_URL=https://assets.example.test \
TRACEJVM_RUNTIME_REQUEST_ORIGIN=https://app.example.test \
  pnpm deploy:runtime-release
```

The upload command always rebuilds and verifies the package and runtime assets
before it constructs the object tree. This prevents a successful upload from
quietly pairing current source with stale `dist` output.

Payload objects upload first and `release.json` uploads last as the release
commit marker. `pnpm check:runtime-release` then downloads and hashes the
published objects; pass `--metadata-only` only for a faster follow-up health
check. Consumers pin the exact descriptor URL once per deployed application
version. They do not poll for runtime releases.

Before publishing the npm package, run:

```sh
pnpm release:check
npm publish
```

## Compatibility

The checked-in OpenJDK sources are copied byte-for-byte from the pinned
`jdk23u` revision and verified by SHA-256:

```sh
pnpm sync:openjdk-tests
pnpm test:compatibility
```

The compatibility lane runs in real browser Workers under cross-origin
isolation. Do not edit an upstream test to make TraceJVM pass. A failure is a VM
gap, a missing explicit host capability, or a documented unsupported jtreg
mode.

See [the architecture](docs/architecture.md),
[the supported Java profile](docs/supported-profile.md), and
[the OpenJDK compatibility policy](compatibility/openjdk/README.md). The
embedding boundary and its deliberately unsupported host ports are recorded
in [embedding TraceJVM](docs/embedding.md). The current evidence,
blockers, and exact CheerpJ replacement criteria are in
[release readiness](docs/release-readiness.md).
