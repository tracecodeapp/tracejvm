import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function readSourceTree(relativeRoot: string): string {
  const absoluteRoot = join(root, relativeRoot);
  const sources: string[] = [];
  const pending = [absoluteRoot];

  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (/\.(?:c|h|java|js|mjs|ts)$/u.test(entry.name)) {
        sources.push(readFileSync(path, "utf8"));
      }
    }
  }

  return sources.join("\n");
}

test("runtime toolchain and Java image are pinned", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "runtime/manifest.json"), "utf8"),
  );
  assert.equal(manifest.javaVersion, "23.0.2+7");
  assert.equal(manifest.emscriptenVersion, "4.0.2");
  assert.equal(manifest.buildTools.emsdk.version, manifest.emscriptenVersion);
  assert.match(manifest.buildTools.emsdk.revision, /^[0-9a-f]{40}$/u);
  assert.equal(manifest.buildTools.hostJdk.version, manifest.javaVersion);
  assert.deepEqual(
    Object.keys(manifest.buildTools.hostJdk.platforms).sort(),
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  );
  for (const artifact of Object.values(
    manifest.buildTools.hostJdk.platforms,
  ) as Array<{ url: string; sha256: string }>) {
    assert.match(artifact.url, /^https:\/\//u);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(
    manifest.buildTools.hostJdk.platforms["linux-x64"].sha256,
    manifest.linuxX64Sha256,
  );
  assert.deepEqual(manifest.profiles.core, ["java.base"]);
  assert.ok(manifest.profiles.server.includes("java.net.http"));
  assert.ok(manifest.profiles.server.includes("jdk.httpserver"));
  assert.ok(manifest.profiles["spring-server"].includes("java.desktop"));

  const build = readFileSync(join(root, "scripts/build-runtime.sh"), "utf8");
  assert.match(build, /SOURCE_DATE_EPOCH=946684800/u);
  assert.match(build, /archive_date="2000-01-01T00:00:00Z"/u);
  assert.match(build, /--date="\$archive_date"/u);
  assert.match(build, new RegExp(manifest.linuxX64Sha256, "u"));
  assert.match(build, /TRACEJVM_REPRODUCIBLE_SOURCE_ROOT=\$repo_root/u);

  const engineCmake = readFileSync(
    join(root, "engine/bjvm/CMakeLists.txt"),
    "utf8",
  );
  assert.match(engineCmake, /-ffile-prefix-map=\$\{TRACEJVM_REPRODUCIBLE_SOURCE_ROOT\}=\/tracejvm-source/u);
  assert.match(engineCmake, /-ffile-prefix-map=\$\{CMAKE_BINARY_DIR\}=\/tracejvm-build/u);

  const nativesCmake = readFileSync(
    join(root, "engine/bjvm/natives/CMakeLists.txt"),
    "utf8",
  );
  const nativeScanner = readFileSync(
    join(root, "engine/bjvm/codegen/scan_native_declarations.py"),
    "utf8",
  );
  assert.match(nativesCmake, /scan_native_declarations\.py \$\{NATIVES_FILES\}/u);
  assert.doesNotMatch(nativesCmake, /list\(JOIN NATIVES_FILES/u);
  assert.match(nativeScanner, /for file in sys\.argv\[1:\]:/u);
  assert.doesNotMatch(nativeScanner, /split\(['"] ['"]\)/u);
});

test("TeaVM javac remains a pinned downstream build overlay", () => {
  const manifestPath = join(
    root,
    "compiler/teavm-javac/manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const runtime = JSON.parse(
    readFileSync(join(root, "runtime/manifest.json"), "utf8"),
  );
  const patches = manifest.overlay.patches.map(
    ({ path, sha256 }: { path: string; sha256: string }) => {
      const content = readFileSync(
        join(root, "compiler/teavm-javac", path),
      );
      return { path, sha256, content };
    },
  );

  assert.equal(manifest.schema, "tracejvm.teavm-javac-source.v1");
  assert.match(manifest.upstream.commit, /^[0-9a-f]{40}$/u);
  assert.match(manifest.upstream.archiveSha256, /^[0-9a-f]{64}$/u);
  assert.equal(manifest.upstream.license, "Apache-2.0");
  assert.equal(manifest.jdk.version, runtime.javaVersion);
  assert.equal(manifest.jdk.feature, 23);
  assert.equal(manifest.jdk.classFileMajor, 67);
  assert.deepEqual(Object.keys(manifest.overlay.patchedFiles).sort(), [
    "compiler/build.gradle",
    "compiler/src/main/java/org/teavm/javac/Compiler.java",
    "compiler/src/main/java/org/teavm/javac/FileData.java",
    "javac/build.gradle",
    "settings.gradle",
  ]);
  for (const patch of patches) {
    assert.equal(
      createHash("sha256").update(patch.content).digest("hex"),
      patch.sha256,
      patch.path,
    );
  }

  const patchText = patches
    .map(({ content }: { content: Buffer }) => content)
    .join("\n");
  assert.match(patchText, /tracejvm\.jdk\.feature/u);
  assert.match(patchText, /compileClasslibEmuJava/u);
  assert.match(patchText, /options\.release/u);
  assert.match(patchText, /path\.endsWith\("\/" \+ expected\)/u);

  const build = readFileSync(
    join(root, "scripts/build-teavm-javac.sh"),
    "utf8",
  );
  assert.match(
    build,
    /patch -d "\$staging" -p1 -i "\$patch_file" -N -t/u,
  );
  assert.match(build, /TeaVM javac build requires JDK/u);
  assert.match(build, /java\.runtime\.version/u);
  assert.match(build, /-Pjdk\.revision=\$jdk_revision/u);
  assert.doesNotMatch(build, /runtime\/assets/u);
});

test("0.4 keeps compiler and runner capabilities physically separate", () => {
  const engine = readFileSync(join(root, "src/engine.ts"), "utf8");
  const compiler = readFileSync(join(root, "src/compiler.ts"), "utf8");
  const protocol = readFileSync(join(root, "src/worker-protocol.ts"), "utf8");
  const workerClient = readFileSync(
    join(root, "src/worker-client.ts"),
    "utf8",
  );
  const runtimeBuild = readFileSync(
    join(root, "scripts/build-runtime.sh"),
    "utf8",
  );
  const runnerBridge = readFileSync(
    join(
      root,
      "runtime/bridge/jdk/internal/tracecode/TraceJVMRunner.java",
    ),
    "utf8",
  );

  assert.doesNotMatch(engine, /TraceJVMEngineRole|role:\s*"compiler"/u);
  assert.doesNotMatch(engine, /new TraceJVMCompiler/u);
  const runnerHost =
    engine.match(/export class TraceJVMRunnerHost[\s\S]*$/u)?.[0] ?? "";
  assert.match(runnerHost, /createProcess/u);
  assert.doesNotMatch(runnerHost, /compile|TraceJVMCompiler/u);
  assert.match(
    engine,
    /this\.kernelBound && request\.processFiles\?\.length/u,
  );
  assert.match(
    engine,
    /initialize\(signal\?: AbortSignal\)[\s\S]*?if \(this\.disposed\)/u,
  );
  assert.match(protocol, /type:\s*"initialize-compiler"/u);
  assert.match(protocol, /type:\s*"compile"/u);
  assert.doesNotMatch(protocol, /runtime-host|create-process|run-process/u);
  assert.doesNotMatch(runtimeBuild, /compiler-23\.jar/u);
  assert.doesNotMatch(runnerBridge, /javax\.tools|JavacTool|\.compile\(/u);
  assert.match(
    runnerBridge,
    /if \(!entry\.isEmpty\(\)\) urls\.add\(new File\(entry\)\.toURI\(\)\.toURL\(\)\)/u,
  );
  assert.match(
    runnerBridge,
    /URLClassLoader\.newInstance\(urls\.toArray\(URL\[\]::new\)\)/u,
  );
  assert.doesNotMatch(
    runnerBridge,
    /SharedJarClassLoader|SHARED_JAR_LOADERS|CRC32|ZipInputStream/u,
  );
  assert.match(compiler, /class TraceJVMCompiler/u);
  assert.match(workerClient, /class TraceJVMCompilerWorkerClient/u);
  assert.doesNotMatch(
    workerClient.match(
      /export class TraceJVMCompilerWorkerClient[\s\S]*$/u,
    )?.[0] ?? "",
    /createProcess|runProcess/u,
  );
  assert.equal(
    existsSync(
      join(
        root,
        "runtime/bridge/jdk/internal/tracecode/InVmCompileAndRun.java",
      ),
    ),
    false,
  );
});

test("asynchronous host calls remain bound to their originating JVM", () => {
  const runtime = readFileSync(
    join(root, "engine/bjvm/js/bjvm2.ts"),
    "utf8",
  );
  const host = readFileSync(
    join(root, "engine/bjvm/natives/emscripten/tracejvm-host.c"),
    "utf8",
  );

  assert.match(runtime, /contexts = new Map<number, RuntimeHostContext>/u);
  assert.match(runtime, /this\.contexts\.get\(contextId\)/u);
  assert.match(runtime, /releaseHostContext\(this\.hostContext\)/u);
  assert.match(host, /dispatch\(\{[\s\S]*?\}, contextId\)\)/u);
  assert.match(host, /dispatch\(request, contextId\)/u);
});

test("host writes reject zero progress before native retry loops", () => {
  const hostBridge = readFileSync(
    join(root, "engine/bjvm/natives/emscripten/tracejvm-host.c"),
    "utf8",
  );
  const fileOutput = readFileSync(
    join(root, "engine/bjvm/natives/share/java/io/FileOutputStream.c"),
    "utf8",
  );
  assert.match(
    hostBridge,
    /length > 0 && result\.bytesWritten === 0/u,
  );
  assert.match(fileOutput, /if \(written <= 0\)/u);
  assert.doesNotMatch(fileOutput, /if \(written < 0\)/u);
});

test("release profile states the supported Java and browser boundary", () => {
  const profile = JSON.parse(
    readFileSync(
      join(root, "compatibility/openjdk/release-profile.json"),
      "utf8",
    ),
  );
  const runtime = JSON.parse(
    readFileSync(join(root, "runtime/manifest.json"), "utf8"),
  );
  const openjdk = JSON.parse(
    readFileSync(
      join(root, "compatibility/openjdk/manifest.json"),
      "utf8",
    ),
  );

  assert.equal(profile.schema, "tracejvm.openjdk-release-profile.v1");
  assert.equal(profile.status, "candidate");
  assert.equal(profile.java.version, runtime.javaVersion);
  assert.equal(profile.java.oracle.commit, openjdk.upstream.commit);
  assert.deepEqual(profile.modules, runtime.profiles[profile.runtimeProfile]);
  assert.deepEqual(profile.browsers, [
    "chromium",
    "firefox",
    "webkit",
    "webkit-ipad-emulation",
  ]);
  assert.equal(profile.releaseGate.crossBrowser, true);
  assert.equal(profile.releaseGate.requireNoSemanticDefects, true);
  assert.equal(profile.releaseGate.requireNoUnclassifiedFailures, true);
});

test("runtime profiles remain explicit and ordered by measured cost", () => {
  const measurement = JSON.parse(
    readFileSync(
      join(root, "docs/runtime-profile-measurement.json"),
      "utf8",
    ),
  );
  assert.equal(
    measurement.schema,
    "tracejvm.runtime-profile-measurement.v1",
  );
  assert.ok(
    measurement.profiles.core.coldAssetBytes <
      measurement.profiles.server.coldAssetBytes,
  );
  assert.ok(
    measurement.profiles.server.coldAssetBytes <
      measurement.profiles["spring-server"].coldAssetBytes,
  );

  const engine = readFileSync(join(root, "src/engine.ts"), "utf8");
  assert.match(engine, /runtimeProfileBaseUrls/u);
  assert.match(
    engine,
    /was requested but no asset URL was provided/u,
  );

  const vm = readFileSync(join(root, "engine/bjvm/vm/bjvm.c"), "utf8");
  assert.match(vm, /module-packages\.map/u);
  assert.match(vm, /system_module_name_for_class/u);
});

test("OpenJDK compatibility sources remain byte-for-byte upstream", () => {
  const manifest = JSON.parse(
    readFileSync(join(root, "compatibility/openjdk/manifest.json"), "utf8"),
  );
  assert.match(manifest.upstream.commit, /^[0-9a-f]{40}$/u);
  assert.ok(manifest.tests.length > 0);
  for (const entry of manifest.tests) {
    const source = readFileSync(
      join(root, "compatibility/openjdk/tests", entry.path),
    );
    const digest = createHash("sha256").update(source).digest("hex");
    assert.equal(digest, entry.sha256, entry.path);
  }
});

test("OpenJDK catalog accounts for broad upstream families", () => {
  const catalog = JSON.parse(
    readFileSync(join(root, "compatibility/openjdk/catalog.json"), "utf8"),
  );
  assert.deepEqual(catalog.scopes, ["java/lang", "java/util", "java/io"]);
  assert.equal(catalog.total, catalog.entries.length);
  assert.ok(catalog.total >= 3_000);
  assert.ok(
    catalog.counts["direct-main-candidate"] +
      catalog.counts["implicit-main-candidate"] >=
      500,
  );
  assert.equal(
    Object.values(catalog.counts).reduce(
      (total: number, count) => total + Number(count),
      0,
    ),
    catalog.total,
  );
});

test("public engine remains independent from consumer adapters", () => {
  const publicSources = [
    "src/engine.ts",
    "src/host.ts",
    "src/index.ts",
    "src/worker-protocol.ts",
    "src/browser-worker.ts",
  ].map((path) => readFileSync(join(root, path), "utf8")).join("\n");

  for (const forbidden of [
    "PracticeRunRequest",
    "ProjectAssessment",
    "TraceKernelProcess",
  ]) {
    assert.equal(
      publicSources.includes(forbidden),
      false,
      `public engine leaked consumer concept: ${forbidden}`,
    );
  }
});

test("hosted TraceKernel controls remain a standalone optional API", () => {
  const api = readFileSync(
    join(
      root,
      "runtime/api/io/tracecode/tracekernel/TraceKernel.java",
    ),
    "utf8",
  );
  assert.match(api, /package io\.tracecode\.tracekernel;/u);
  assert.match(api, /armWatchdog/u);
  assert.match(api, /setProcessGroup/u);
  assert.match(api, /terminalForegroundProcessGroup/u);
  assert.match(api, /terminalWindowSize/u);
  assert.match(api, /addWindowSizeListener/u);
  assert.match(api, /pollSignal0/u);
  assert.doesNotMatch(api, /TraceKernelProcess/u);

  const build = readFileSync(join(root, "scripts/build-runtime.sh"), "utf8");
  assert.match(build, /tracekernel-api\.jar/u);
  assert.match(build, /runtime\/api\/io\/tracecode\/tracekernel/u);

  const nativeHost = readFileSync(
    join(root, "engine/bjvm/natives/emscripten/tracejvm-host.c"),
    "utf8",
  );
  assert.match(nativeHost, /service: "signal"/u);
  for (const operation of ["watchdog", "setsid"]) {
    assert.match(nativeHost, new RegExp(`operation: "${operation}"`, "u"));
  }
  assert.match(
    nativeHost,
    /const names = \["setpgid", "tcgetpgrp", "tcsetpgrp"\];/u,
  );
  for (const operation of ["tcgetwinsize", "tcsetwinsize"]) {
    assert.match(nativeHost, new RegExp(`"${operation}"`, "u"));
  }
});

test("vendored engine remains independent from TraceJVM integration policy", () => {
  const engineSources = readSourceTree("engine/bjvm");
  for (const forbidden of ["TraceJVM", "TraceCode"]) {
    assert.equal(
      engineSources.includes(forbidden),
      false,
      `vendored engine leaked integration identity: ${forbidden}`,
    );
  }
});

test("application tracing remains an embedder concern rather than a JVM protocol", () => {
  const implementationSources = [
    readSourceTree("src"),
    readSourceTree("runtime/bridge"),
    readSourceTree("engine/bjvm"),
  ].join("\n");

  for (const forbidden of [
    "RuntimeTrace",
    "TraceHooks",
    "traceEvent",
    "trace-event",
    "instrumentSource",
    "rewriteForTrace",
  ]) {
    assert.equal(
      implementationSources.includes(forbidden),
      false,
      `TraceJVM implementation leaked application tracing concept: ${forbidden}`,
    );
  }
});
