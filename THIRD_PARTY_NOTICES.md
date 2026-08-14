# Third-party notices

## b-jvm

TraceJVM began from b-jvm commit
`3fd56c74656602eb32efefca46f51f074bef6bca`, originally published at
<https://github.com/anematode/b-jvm>.

b-jvm is licensed under the MIT License. Its original license is preserved at
`engine/bjvm/LICENSE`.

## OpenJDK / Eclipse Temurin

TraceJVM runtime images are assembled from Eclipse Temurin/OpenJDK artifacts.
OpenJDK is distributed under GPLv2 with the Classpath Exception. Runtime build
inputs, versions, and checksums are pinned by `runtime/manifest.json` and
`scripts/build-runtime.sh`. Every immutable runtime release includes Temurin's
complete module-level legal tree and NOTICE, the exact runtime and compiler
source archives, and TraceJVM's build scripts and patches. See
`legal/CORRESPONDING_SOURCE.md` in the release.

## TeaVM javac

The TraceJVM browser compiler is built from
[`konsoletyper/teavm-javac`](https://github.com/konsoletyper/teavm-javac),
licensed under Apache License 2.0. Its upstream commit, source checksum, and
TraceJVM-owned build overlay are pinned by
`compiler/teavm-javac/manifest.json`.

TraceJVM records its downstream modifications in
`compiler/teavm-javac/NOTICE` and distributes the complete Apache 2.0 text from
`compiler/teavm-javac/LICENSE` with every immutable runtime release.

The resulting WebAssembly contains compiler components built from OpenJDK
sources under GPLv2 with the Classpath Exception. TraceJVM does not modify the
OpenJDK sources; it selects the exact OpenJDK 23.0.2+7 revision during the
compiler build.

## Effect

TraceJVM uses [Effect](https://effect.website/) for typed lifecycle programs,
services, layers, and scoped cleanup. Effect is licensed under the MIT License.
