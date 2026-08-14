import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  contentTypeForTraceJVMAsset,
  normalizeTraceJVMReleasePath,
  prepareTraceJVMRuntimeRelease,
  readTraceJVMRuntimeRelease,
  verifyTraceJVMRuntimeRelease,
  TRACEJVM_RUNTIME_CACHE_CONTROL,
  TRACEJVM_RUNTIME_RELEASE_SCHEMA,
  TRACEJVM_RUNTIME_RESPONSE_POLICY,
} from "../../scripts/runtime-release-lib.mjs";

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tracejvm-release-"));
  try {
    const runtimeSource = Buffer.from("runtime source");
    const compilerSource = Buffer.from("compiler source");
    const teavmSource = Buffer.from("teavm source");
    const digest = (content: Buffer) =>
      createHash("sha256").update(content).digest("hex");
    const compilerCommit = "teavm-commit";
    const jdkRevision = "jdk-revision";
    const runtimeRevision = "runtime-revision";
    const compilerSourceRoot = join(
      root,
      ".cache",
      "teavm-javac",
      `source-${compilerCommit}-overlay-3`,
      "javac",
      "build",
      "jdk",
      `jdk23u-${jdkRevision}`,
    );
    const temurinLegalRoot = join(
      root,
      ".cache",
      "runtime-legal",
      "temurin-23.0.2_7",
    );
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(root, "runtime", "assets", "profiles", "core"), {
      recursive: true,
    });
    mkdirSync(join(root, ".cache", "teavm-javac", "artifacts"), {
      recursive: true,
    });
    mkdirSync(join(root, "engine", "bjvm"), { recursive: true });
    for (const directory of ["cmake", "codegen", "js", "natives", "vendor", "vm"]) {
      mkdirSync(join(root, "engine", "bjvm", directory), { recursive: true });
    }
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "engine", "bjvm", "js", "pages", "dist"), {
      recursive: true,
    });
    symlinkSync(
      join(root, "dist", "browser-worker.js"),
      join(root, "engine", "bjvm", "js", "pages", "dist", "worker.js"),
    );
    mkdirSync(join(root, "compiler", "teavm-javac", "patches"), {
      recursive: true,
    });
    mkdirSync(join(root, "runtime", "api"), { recursive: true });
    mkdirSync(join(root, "runtime", "bridge"), { recursive: true });
    mkdirSync(join(root, "scripts", "java"), { recursive: true });
    mkdirSync(join(root, "legal"), { recursive: true });
    mkdirSync(join(root, ".cache", "runtime-sources"), { recursive: true });
    mkdirSync(join(temurinLegalRoot, "legal", "java.base"), {
      recursive: true,
    });
    mkdirSync(compilerSourceRoot, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@tracecode/tracejvm", version: "0.1.0" }),
    );
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "tsconfig.json"), "{}\n");
    writeFileSync(
      join(root, "runtime", "manifest.json"),
      JSON.stringify({
        javaVersion: "23.0.2+7",
        source: {
          revision: runtimeRevision,
          archiveSha256: digest(runtimeSource),
        },
        profiles: { core: ["java.base"] },
      }),
    );
    writeFileSync(
      join(root, "compiler", "teavm-javac", "manifest.json"),
      JSON.stringify({
        upstream: {
          commit: compilerCommit,
          archiveSha256: digest(teavmSource),
        },
        overlay: { version: 3 },
        jdk: {
          archiveRoot: "jdk23u",
          revision: jdkRevision,
          archiveSha256: digest(compilerSource),
        },
      }),
    );
    writeFileSync(join(root, "dist", "browser-client.js"), "client");
    writeFileSync(join(root, "dist", "browser-worker.js"), "worker");
    writeFileSync(join(root, "LICENSE"), "TraceJVM license");
    writeFileSync(
      join(root, "THIRD_PARTY_NOTICES.md"),
      "TraceJVM third-party notices",
    );
    writeFileSync(join(root, "engine", "bjvm", "LICENSE"), "b-jvm license");
    writeFileSync(join(root, "engine", "bjvm", "CMakeLists.txt"), "project(bjvm)");
    writeFileSync(join(root, "engine", "bjvm", "CMakePresets.json"), "{}\n");
    writeFileSync(join(root, "engine", "bjvm", "cmake", "Module.cmake"), "module");
    writeFileSync(join(root, "engine", "bjvm", "codegen", "generate.ts"), "codegen");
    writeFileSync(join(root, "engine", "bjvm", "js", "bjvm2.ts"), "engine");
    writeFileSync(join(root, "engine", "bjvm", "natives", "TextOps.c"), "native");
    writeFileSync(join(root, "engine", "bjvm", "vendor", "CMakeLists.txt"), "vendor");
    writeFileSync(join(root, "engine", "bjvm", "vm", "bjvm.c"), "vm");
    writeFileSync(join(root, "src", "browser-worker.ts"), "worker source");
    writeFileSync(
      join(root, "compiler", "teavm-javac", "LICENSE"),
      "TeaVM-javac license",
    );
    writeFileSync(
      join(root, "compiler", "teavm-javac", "NOTICE"),
      "TeaVM-javac notice",
    );
    writeFileSync(
      join(root, "legal", "CORRESPONDING_SOURCE.md"),
      "Corresponding source",
    );
    writeFileSync(join(temurinLegalRoot, "NOTICE"), "Temurin notice");
    writeFileSync(
      join(temurinLegalRoot, "legal", "java.base", "LICENSE"),
      "Temurin module license",
    );
    writeFileSync(join(compilerSourceRoot, "LICENSE"), "OpenJDK license");
    writeFileSync(
      join(compilerSourceRoot, "ASSEMBLY_EXCEPTION"),
      "OpenJDK assembly exception",
    );
    writeFileSync(
      join(compilerSourceRoot, "ADDITIONAL_LICENSE_INFO"),
      "OpenJDK additional license information",
    );
    writeFileSync(
      join(
        root,
        ".cache",
        "runtime-sources",
        `adoptium-jdk23u-${runtimeRevision}.tar.gz`,
      ),
      runtimeSource,
    );
    writeFileSync(
      join(
        root,
        ".cache",
        "runtime-sources",
        `openjdk-jdk23u-${jdkRevision}.zip`,
      ),
      compilerSource,
    );
    writeFileSync(
      join(
        root,
        ".cache",
        "runtime-sources",
        `teavm-javac-${compilerCommit}.tar.gz`,
      ),
      teavmSource,
    );
    writeFileSync(
      join(root, "compiler", "teavm-javac", "patches", "0001.patch"),
      "patch",
    );
    writeFileSync(join(root, "runtime", "api", "Api.java"), "class Api {}");
    writeFileSync(
      join(root, "runtime", "bridge", "Bridge.java"),
      "class Bridge {}",
    );
    writeFileSync(join(root, "scripts", "build-runtime.sh"), "build runtime");
    writeFileSync(
      join(root, "scripts", "build-teavm-javac.sh"),
      "build compiler",
    );
    writeFileSync(
      join(root, "scripts", "bootstrap-toolchain.mjs"),
      "bootstrap toolchain",
    );
    writeFileSync(
      join(root, "scripts", "java", "GenerateHotAot.java"),
      "class GenerateHotAot {}",
    );
    writeFileSync(
      join(root, "runtime", "assets", "bjvm_main.wasm"),
      Buffer.from([0, 97, 115, 109]),
    );
    writeFileSync(
      join(root, "runtime", "assets", "profiles", "core", "jdk23.jar"),
      "jar",
    );
    writeFileSync(
      join(root, ".cache", "teavm-javac", "artifacts", "compiler.wasm"),
      Buffer.from([0, 97, 115, 109]),
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("runtime releases are deterministic, immutable, and self-describing", () => {
  withFixture((root) => {
    const runtimeFixture = JSON.parse(
      readFileSync(join(root, "runtime", "manifest.json"), "utf8"),
    );
    const compilerFixture = JSON.parse(
      readFileSync(
        join(root, "compiler", "teavm-javac", "manifest.json"),
        "utf8",
      ),
    );
    const first = prepareTraceJVMRuntimeRelease({ root });
    const firstDescriptor = readFileSync(first.descriptorPath, "utf8");
    const second = prepareTraceJVMRuntimeRelease({ root });
    const secondDescriptor = readFileSync(second.descriptorPath, "utf8");

    assert.equal(first.contentHash, second.contentHash);
    assert.equal(firstDescriptor, secondDescriptor);
    assert.equal(first.descriptor.schema, TRACEJVM_RUNTIME_RELEASE_SCHEMA);
    assert.deepEqual(
      first.descriptor.responsePolicy,
      TRACEJVM_RUNTIME_RESPONSE_POLICY,
    );
    assert.equal(
      first.relativePrefix,
      `tracejvm/0.1.0/${first.contentHash}`,
    );
    assert.match(first.contentHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.descriptor.entrypoints, {
      browserClient: "browser-client.js",
      browserWorker: "browser-worker.js",
      wasm: "bjvm_main.wasm",
      compiler: "compiler",
      profiles: { core: "profiles/core" },
    });
    assert(
      first.descriptor.files.every(
        (file) =>
          file.integrity.startsWith("sha256-") &&
          file.sha256.length === 64 &&
          file.cacheControl === TRACEJVM_RUNTIME_CACHE_CONTROL,
      ),
    );
    assert.deepEqual(
      first.descriptor.files
        .map((file) => file.path)
        .filter((path) => path.startsWith("legal/")),
      [
        "legal/B-JVM-MIT.txt",
        "legal/CORRESPONDING_SOURCE.md",
        "legal/OPENJDK-COMPILER-ADDITIONAL-LICENSE-INFO.txt",
        "legal/OPENJDK-COMPILER-ASSEMBLY-EXCEPTION.txt",
        "legal/OPENJDK-COMPILER-GPL-2.0-WITH-CLASSPATH-EXCEPTION.txt",
        "legal/TEAVM-JAVAC-APACHE-2.0.txt",
        "legal/TEAVM-JAVAC-NOTICE.txt",
        "legal/TEMURIN-23.0.2+7-NOTICE.txt",
        "legal/TEMURIN-23.0.2+7/java.base/LICENSE",
        "legal/THIRD_PARTY_NOTICES.md",
        "legal/TRACEJVM-AGPL-3.0.txt",
      ],
    );
    assert.deepEqual(
      first.descriptor.files
        .map((file) => file.path)
        .filter((path) => path.startsWith("source/")),
      [
        `source/adoptium-jdk23u-${runtimeFixture.source.revision}.tar.gz`,
        `source/openjdk-jdk23u-${compilerFixture.jdk.revision}.zip`,
        `source/teavm-javac-${compilerFixture.upstream.commit}.tar.gz`,
        "source/tracejvm/compiler/teavm-javac/manifest.json",
        "source/tracejvm/compiler/teavm-javac/patches/0001.patch",
        "source/tracejvm/engine/bjvm/cmake/Module.cmake",
        "source/tracejvm/engine/bjvm/CMakeLists.txt",
        "source/tracejvm/engine/bjvm/CMakePresets.json",
        "source/tracejvm/engine/bjvm/codegen/generate.ts",
        "source/tracejvm/engine/bjvm/js/bjvm2.ts",
        "source/tracejvm/engine/bjvm/natives/TextOps.c",
        "source/tracejvm/engine/bjvm/vendor/CMakeLists.txt",
        "source/tracejvm/engine/bjvm/vm/bjvm.c",
        "source/tracejvm/package.json",
        "source/tracejvm/pnpm-lock.yaml",
        "source/tracejvm/runtime/api/Api.java",
        "source/tracejvm/runtime/bridge/Bridge.java",
        "source/tracejvm/runtime/manifest.json",
        "source/tracejvm/scripts/bootstrap-toolchain.mjs",
        "source/tracejvm/scripts/build-runtime.sh",
        "source/tracejvm/scripts/build-teavm-javac.sh",
        "source/tracejvm/scripts/java/GenerateHotAot.java",
        "source/tracejvm/src/browser-worker.ts",
        "source/tracejvm/tsconfig.json",
      ],
    );
    assert.deepEqual(
      readTraceJVMRuntimeRelease(first.outputDirectory).descriptor,
      first.descriptor,
    );
    assert.deepEqual(
      verifyTraceJVMRuntimeRelease(first.outputDirectory).descriptor,
      first.descriptor,
    );

    const tamperedPath = join(first.outputDirectory, "browser-worker.js");
    writeFileSync(tamperedPath, "tampered worker");
    assert.throws(
      () => verifyTraceJVMRuntimeRelease(first.outputDirectory),
      /file identity mismatch/,
    );
  });
});

test("runtime release content types cover browser and Java artifacts", () => {
  assert.equal(
    contentTypeForTraceJVMAsset("browser-worker.js"),
    "application/javascript; charset=utf-8",
  );
  assert.equal(
    contentTypeForTraceJVMAsset("bjvm_main.wasm"),
    "application/wasm",
  );
  assert.equal(
    contentTypeForTraceJVMAsset("compiler/compiler.wasm"),
    "application/wasm",
  );
  assert.equal(
    contentTypeForTraceJVMAsset("profiles/core/Foo.class"),
    "application/java-vm",
  );
  assert.equal(
    contentTypeForTraceJVMAsset("profiles/core/jdk23/lib/modules"),
    "application/octet-stream",
  );
  assert.equal(
    contentTypeForTraceJVMAsset("profiles/core/module-packages.map"),
    "text/plain; charset=utf-8",
  );
  assert.equal(
    contentTypeForTraceJVMAsset("legal/TEAVM-JAVAC-APACHE-2.0.txt"),
    "text/plain; charset=utf-8",
  );
});

test("runtime release paths cannot escape their immutable prefix", () => {
  assert.equal(
    normalizeTraceJVMReleasePath("tracejvm/0.1.0/abc/browser-worker.js"),
    "tracejvm/0.1.0/abc/browser-worker.js",
  );
  for (const path of [
    "",
    "/absolute",
    "../release.json",
    "profiles/../release.json",
    "profiles//core",
    "profiles\\core",
  ]) {
    assert.throws(() => normalizeTraceJVMReleasePath(path));
  }
});
