# Corresponding source

Every immutable TraceJVM runtime release carries the source inputs used to
produce its OpenJDK-derived browser artifacts:

- `source/adoptium-jdk23u-<revision>.tar.gz` is the exact Eclipse Temurin
  runtime source revision recorded by the distributed JDK.
- `source/openjdk-jdk23u-<revision>.zip` is the exact OpenJDK javac source
  revision compiled to WebAssembly.
- `source/teavm-javac-<revision>.tar.gz` is the exact TeaVM-javac source
  archive.
- `source/tracejvm/` contains TraceJVM's package and TypeScript sources,
  manifests, downstream patches, runtime bridge sources, build scripts, and
  the exact b-jvm C/C++/JavaScript source tree used to build `bjvm_main.wasm`.
  Tests and local build outputs are intentionally excluded; the release build
  configures b-jvm with `BUILD_TESTING=OFF`.

The revisions, upstream URLs, and SHA-256 checksums are recorded in
`runtime/manifest.json` and
`compiler/teavm-javac/manifest.json`. The source payloads are listed and
hashed in the same `release.json` as the executable assets and are available
under the same immutable release prefix.

The host JDK archive and Emsdk checkout used by the build are also pinned in
`runtime/manifest.json`. A clean checkout can acquire them, verify their
identities, and rebuild both runtime layers with:

```sh
pnpm bootstrap:toolchain -- --build
```

The native build rewrites checkout and build directories to canonical virtual
prefixes, so the WebAssembly identity does not depend on a maintainer's local
path or SSD mount name.

Use `--root=/path/on/a/large/disk` to place the downloaded host toolchain away
from the repository cache.

The OpenJDK-derived portions are distributed under GNU GPL version 2 with the
applicable Classpath and OpenJDK Assembly Exceptions. TraceJVM's independent
code remains under the license identified in `TRACEJVM-AGPL-3.0.txt`.
