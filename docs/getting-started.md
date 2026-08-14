# Getting started

This page takes you from an empty project to a Java program compiling and
running in a browser tab. It assumes you have read the
[README](../README.md) and know what TraceJVM does and does not do.

You need:

- Node.js 22.15.0 or newer (the runtime archive tooling requires it);
- a static origin you control, to serve the runtime from;
- a bundler or dev server that can load ES modules and Web Workers.

Java is *not* required. You only need a JDK if you rebuild the runtime from
source, which [CONTRIBUTING.md](../CONTRIBUTING.md) covers.

## 1. Install

```sh
npm install @tracecode/tracejvm
```

## 2. Put the runtime on your origin

The package carries the whole runtime as one verified Zstandard archive. Expand
it once, at build time, into whatever directory your server serves:

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

Every entry is checked against the size and SHA-256 recorded in the manifest as
it is written, so a corrupted or tampered archive fails the build rather than
your users' tabs.

Two things about the extracted tree:

- Keep the `legal/` directory with it. Those are notices you are obliged to
  distribute alongside the runtime bytes.
- Keep a copy of `manifest.json` somewhere your application code can import it,
  for example `src/tracejvm-runtime-manifest.json`. It is the trust anchor for
  the next step.

**Pin the manifest; do not fetch it at runtime.** A manifest downloaded from the
same mutable origin that serves the assets is not a trust anchor — one
compromise could replace the manifest and the payload together.

Install the tree at any static origin you control, but do not mix and match: the
package owns the API and the exact runtime it shipped with, as a pair.
Substituting independently versioned JVM assets is unsupported.

## 3. Compile, then run

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

const compiler = new TraceJVMCompiler({
  assets: {
    baseUrl: `${releaseBaseUrl}/compiler`,
    integrity,
  },
  platformArchiveUrl: `${releaseBaseUrl}/profiles/core/jdk23.jar`,
});

const runner = new TraceJVMEngine({
  assets: {
    runtimeProfileBaseUrls: {
      core: `${releaseBaseUrl}/profiles/core`,
    },
    wasmUrl: `${releaseBaseUrl}/bjvm_main.wasm`,
    integrity,
  },
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

console.log(result.stdout); // hello world
```

`createTraceJVMAssetIntegrityMap` turns the pinned manifest into a
URL-to-digest map. TraceJVM refuses to fetch any asset that has no entry in
that map, and refuses to use one whose bytes do not match.

A few details worth knowing early:

- `compile()` returns `status`, `exitCode`, `stdout`, `stderr`, structured
  `diagnostics`, and `program` on success. Compiler errors are a normal result,
  not a thrown exception.
- `run()` always needs `mainClass`. There is no `java -jar` entry point:
  put the JAR on `classpath` and name the class yourself.
- `classpath` entries must be `.jar` or `.class` files, supplied as
  `{ path, content: Uint8Array }`.
- `run()` returns `stdout`/`stderr` plus `timings`, an `isolation` report, and
  `retirementRecommended`. Pass `onStdout`/`onStderr` to stream output instead
  of waiting for it.
- Both accept an `AbortSignal` via `signal`.
- The default runtime profile is `core` (`java.base`). Larger `server` and
  `spring-server` profiles exist but stay experimental — see
  [runtime-profiles.md](runtime-profiles.md).

Every method also has a typed [Effect](https://effect.website/) counterpart
(`initializeEffect`, `compileEffect`, `runEffect`), described in
[architecture.md](architecture.md).

## 4. Serve the runtime correctly

Serve every release object with the CORS, resource-policy, MIME, and
immutable-caching headers recorded in `release.json`, the contract written by
`pnpm prepare:runtime-release`. If you publish the tree to object storage,
`pnpm check:runtime-release` downloads it and checks the response headers as
well as the bytes.

Any page that supplies a host adapter must be cross-origin isolated:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

That is because the synchronous host bridge uses a `SharedArrayBuffer`, which
browsers only expose to cross-origin-isolated pages.

## 5. Move it into Workers

The snippet above constructs the compiler and runner wherever your code runs —
fine for a first look, wrong for a real application, because a long-running Java
program would block that thread. Real applications put both in Workers:

| Shape | Use it when |
| --- | --- |
| `TraceJVMCompilerWorkerClient` + one `TraceJVMWorkerClient` per program | The normal topology: one warm compiler, disposable runners |
| `TraceJVMWorkerClient` alone | You already have classfiles and just need an isolated runner |
| `TraceJVMCompiler` + `TraceJVMRunnerHost` | Compiler and runners share one Worker you own, and should load the JDK and Wasm once |

Both Worker clients take a `createWorker` factory, so you decide how the Worker
script is built and served. The simplest option is the prebuilt
`browser-worker.js` that step 2 already extracted onto your origin:

```ts
import {
  TraceJVMWorkerClient,
  type TraceJVMWorkerLike,
} from "@tracecode/tracejvm";

const runner = new TraceJVMWorkerClient({
  engine: {
    assets: {
      runtimeProfileBaseUrls: { core: `${releaseBaseUrl}/profiles/core` },
      wasmUrl: `${releaseBaseUrl}/bjvm_main.wasm`,
      integrity,
    },
  },
  createWorker: () =>
    new Worker(`${releaseBaseUrl}/browser-worker.js`, {
      type: "module",
    }) as unknown as TraceJVMWorkerLike,
});
```

`TraceJVMWorkerLike` narrows the message types, so the DOM `Worker` needs that
cast — the same one the repository's own browser tests use.

If you would rather bundle the Worker yourself, the package also exports the
same entry point as `@tracecode/tracejvm/worker`; how you turn that into a
Worker URL is your bundler's business.

Keep one compiler Worker warm across the session and create a runner Worker per
admitted program. Runners stay independent — separate PIDs, working
directories, host calls, Java heaps, and output routes — and terminating one
never discards the compiler. TraceJVM never ships a combined compiler/runner
object; even `TraceJVMRunnerHost` gives every `createProcess()` call a fresh
disposable JVM and has no compiler API.

### Lifecycle

Terminating a Worker is the only hard disposal boundary, so aborts terminate by
default (`hardAbort`). Every run returns an `isolation` report; when it comes
back `status: "tainted"` — notably after the program creates a thread — the
default client retires that Worker instead of reusing it
(`retireAutomatically`). Both defaults are safe; turning either off is an
explicit tradeoff.

This is a lifecycle boundary, not a security sandbox. What isolation does and
does not restore is spelled out in [architecture.md](architecture.md); the full
topology and host-adapter boundary is in [embedding.md](embedding.md).

### Resource limits

Compiler and runner requests are rejected *before* Worker transfer when they
exceed the exported `TRACEJVM_DEFAULT_RESOURCE_LIMITS`:

| Limit | Default |
| --- | --- |
| `maxInputFiles` | 4,096 payload entries |
| `maxInputBytes` | 128 MiB of aggregate input |
| `maxFileBytes` | 64 MiB per file or string entry |
| `maxOutputBytes` | 4 MiB of combined output or compiler diagnostics |

Pass a partial `limits` object to `TraceJVMCompilerOptions`, `TraceJVMOptions`,
or `TraceJVMRunnerHostOptions` to tighten them.

## Where to go next

- [supported-profile.md](supported-profile.md) — what the compatibility
  contract promises and refuses.
- [architecture.md](architecture.md) — component boundaries, the Effect
  surface, isolation internals.
- [embedding.md](embedding.md) — host adapters, TraceKernel, the verified
  integration matrix.
- [runtime-profiles.md](runtime-profiles.md) — profile contents, size and
  memory measurements.
- [../SUPPORT.md](../SUPPORT.md) — where to ask when something here does not
  work.
