# TraceJVM

TraceJVM runs real Java in a web browser. It pairs a genuine OpenJDK 23 `javac`
with a real JVM, both compiled to WebAssembly, so `.java` source becomes
ordinary classfiles and those classfiles actually execute. No server, no plugin,
and no translation of Java into JavaScript — it all happens in the user's own
tab.

It ships as one npm package, `@tracecode/tracejvm`, containing the JavaScript
API and the exact runtime bytes it was released with. You serve those bytes from
an origin you control; there is no hosted service to sign up for and nothing
phones home. The compiler and the runner are deliberately separate halves: the
compiler turns source into classfiles and cannot execute anything, the runner
executes classfiles and cannot read source, and you wire the two together. That
way a program that crashes or gets terminated takes only its own runner with it.
Everything above the JVM stays yours as well: files, processes, terminals, and
networking are interfaces you implement.

> TraceJVM is an independent project and is not affiliated with, sponsored by,
> or endorsed by Oracle Corporation or the OpenJDK project.

## What it can and cannot do

**It can** compile and run ordinary Java 23 programs: multi-file source trees,
packages, program arguments, system properties, captured stdout/stderr,
JARs placed on the classpath with an explicit main class, and classfiles you
supply directly. Behavior is checked against unmodified OpenJDK tests in
Chromium, Firefox, WebKit, and WebKit under iPad emulation.

**It cannot** do these, and does not pretend to:

| Not supported | Why |
| --- | --- |
| Full Java SE compatibility | The supported profile is `core` (`java.base`); gaps are measured and published, not assumed |
| Preview language features | Source and target level 23, preview off |
| GUI, audio, desktop integration | No AWT/Swing/graphics stack, even where a profile ships `java.desktop` classes |
| JNI and unimplemented OpenJDK natives | Failures are explicit, never silent no-ops |
| OS processes, or unrestricted files and network | None exist in a browser tab; supply a host adapter or the calls fail |
| Interactive stdin | Outside the current supported profile |
| Multi-tenant sandboxing on its own | TraceJVM is a library; you own authorization and Worker policy |

Roughly: the runtime starts in 0.2–0.3 s; a cold compile takes about 2 s in
Chromium and WebKit, about 9 s in Firefox, and much less when warm; the smallest
profile is about 29 MB of cold assets. Larger `server` and `spring-server`
profiles exist but stay experimental. Measurements and method:
[docs/runtime-profiles.md](docs/runtime-profiles.md) and
[docs/firefox-performance.md](docs/firefox-performance.md).

## Status

TraceJVM 0.4 is **pre-release**. Public APIs and runtime profiles may change
between minor releases. Compatibility is measured rather than claimed: the
OpenJDK test lane is the authority, and known gaps stay visible in the reports.
[docs/release-readiness.md](docs/release-readiness.md) has the current evidence
and the remaining blockers.

## Quick start

You need Node.js 22+ and a static origin you control. Java is *not* required —
only for rebuilding the runtime from source.

### 1. Install

```sh
pnpm add @tracecode/tracejvm
```

### 2. Put the runtime on your origin

The package carries the runtime as one verified Zstandard archive. Expand it
once, at build time, into whatever directory your server serves:

```js
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { extractTraceJVMRuntimeArchive } from "@tracecode/tracejvm/runtime-package";

const require = createRequire(import.meta.url);
const releaseRoot = join(
  dirname(require.resolve("@tracecode/tracejvm/package.json")),
  "runtime-release",
);
const manifest = JSON.parse(
  await readFile(join(releaseRoot, "manifest.json"), "utf8"),
);

// The destination must be empty; extraction refuses to overwrite.
await extractTraceJVMRuntimeArchive({
  archivePath: join(releaseRoot, manifest.archive.path),
  destination: "public/tracejvm",
  files: manifest.files,
});
```

Every entry is checked against the size and SHA-256 in the manifest as it is
written. Keep the resulting `legal/` directory with the tree — it carries
notices you are obliged to distribute alongside those bytes.

Keep a copy of `manifest.json` where your application code can import it. It is
the trust anchor for the next step, and must reach you through the package — not
by fetching it from the origin that serves the assets.

### 3. Compile, then run

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
const runner = new TraceJVMEngine({ assets: runtimeAssets });

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

`createTraceJVMAssetIntegrityMap` turns the manifest into a URL-to-digest map.
TraceJVM refuses to fetch any asset with no pinned entry, and refuses to use one
whose bytes do not match.

Every method also has a typed [Effect](https://effect.website/) counterpart
(`initializeEffect`, `compileEffect`, `runEffect`); see
[docs/architecture.md](docs/architecture.md).

## Recommended setup: Workers

`TraceJVMCompiler` and `TraceJVMEngine` run wherever you construct them. Real
applications should put them in Workers:

| Shape | Use it when |
| --- | --- |
| `TraceJVMCompilerWorkerClient` + one `TraceJVMWorkerClient` per program | The normal topology: one warm compiler, disposable runners |
| `TraceJVMWorkerClient` alone | You already have classfiles and just need an isolated runner |
| `TraceJVMCompiler` + `TraceJVMRunnerHost` | Compiler and runners share one Worker you own and should load the JDK and Wasm once |

Keep one compiler Worker warm across the session and create a runner Worker per
admitted program. Runners stay independent — separate PIDs, working directories,
host calls, Java heaps, and output routes — and terminating one never discards
the compiler. TraceJVM never ships a combined compiler/runner object; even
`TraceJVMRunnerHost` gives every `createProcess()` call a fresh disposable JVM
and has no compiler API.

Terminating a Worker is the only hard disposal boundary, so aborts terminate by
default. Every run returns an `isolation` report; when it comes back
`status: "tainted"` (notably after the program creates a thread), the default
Worker client retires that Worker instead of reusing it. This is a lifecycle
boundary, not a security sandbox. Full topologies and the host-adapter boundary:
[docs/embedding.md](docs/embedding.md). What isolation does and does not
restore: [docs/architecture.md](docs/architecture.md).

## Serving the runtime safely

Any page that supplies a host adapter must be cross-origin isolated
(`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), because the synchronous host
bridge uses a `SharedArrayBuffer`. Serve every release object with the CORS,
resource-policy, MIME, and immutable-caching headers recorded in `release.json`;
`pnpm check:runtime-release` verifies the headers as well as the bytes.

Build your integrity map from the manifest committed in the package, or another
copy pinned in your deployment. **An unpinned manifest fetched from the same
mutable origin that serves the assets is not a trust anchor** — one compromise
could replace the manifest and the payload together. Install the runtime tree at
any static origin you control, but do not substitute independently versioned JVM
assets: the package owns the API and the exact runtime it shipped with, as a
pair.

Compiler and runner requests are rejected *before* Worker transfer when they
exceed the exported `TRACEJVM_DEFAULT_RESOURCE_LIMITS`: 4,096 payload entries,
128 MiB of aggregate input, 64 MiB per file or string entry, and 4 MiB of
combined output or compiler diagnostics. Pass a partial `limits` object to
`TraceJVMCompilerOptions`, `TraceJVMOptions`, or `TraceJVMRunnerHostOptions` to
tighten them.

## Where to go next

| Document | What's in it |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Component boundaries, Effect surface, ownership split, isolation internals |
| [docs/supported-profile.md](docs/supported-profile.md) | What the compatibility contract promises and refuses |
| [docs/embedding.md](docs/embedding.md) | Host adapters, TraceKernel, the verified integration matrix, unsupported ports |
| [docs/runtime-profiles.md](docs/runtime-profiles.md) | Profile contents, size and memory measurements, reproduction |
| [docs/release-readiness.md](docs/release-readiness.md) | Current evidence, benchmarks, and remaining blockers |
| [compatibility/openjdk/README.md](compatibility/openjdk/README.md) | How OpenJDK results are classified and why none are hidden |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Building from source, releasing, and getting a change landed |
| [SUPPORT.md](SUPPORT.md) | Where to ask questions and what to include |
| [SECURITY.md](SECURITY.md) | Threat model, invariants, and private reporting |

## License and attribution

TraceJVM's own code is licensed under **AGPL-3.0-only**; the full text is in
[LICENSE](LICENSE).

Redistributing the runtime carries obligations under several licenses. OpenJDK /
Eclipse Temurin runtime images and the compiler built from OpenJDK sources are
GPLv2 with the Classpath Exception;
[b-jvm](https://github.com/anematode/b-jvm), which the runner derives from, is
MIT; TeaVM-javac is Apache 2.0, with TraceJVM's modifications recorded in
`compiler/teavm-javac/NOTICE`; Effect is MIT. The npm runtime archive carries
the required license and notice files, but omits the much larger corresponding-
source archives. Those ship in the matching complete hosted release described
by `release.json`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
[legal/CORRESPONDING_SOURCE.md](legal/CORRESPONDING_SOURCE.md) before
redistributing the runtime.
