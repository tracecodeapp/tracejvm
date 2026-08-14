#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const testRoot = join(root, "engine", "bjvm", "test");
const fixedJarDate = "2025-01-01T00:00:00Z";
const runtimeManifest = JSON.parse(
  await readFile(join(root, "runtime", "manifest.json"), "utf8"),
);

const mavenFixtures = [
  {
    path: "test_files/json/gson-2.11.0.jar",
    url: "https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar",
    sha256: "57928d6e5a6edeb2abd3770a8f95ba44dce45f3b23b7a9dc2b309c581552a78b",
  },
  {
    path: "test_files/json/jackson-annotations-2.18.2.jar",
    url: "https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-annotations/2.18.2/jackson-annotations-2.18.2.jar",
    sha256: "581bd61000ef7648943f781ca05689e56d03f6052748365a8e2b3a9b5d3fa32f",
  },
  {
    path: "test_files/json/jackson-core-2.18.2.jar",
    url: "https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-core/2.18.2/jackson-core-2.18.2.jar",
    sha256: "d8054ae7c0d1c2d2f55d28e46026ebe5892881f3fab5f439233184381c3b4a1f",
  },
  {
    path: "test_files/json/jackson-databind-2.18.2.jar",
    url: "https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-databind/2.18.2/jackson-databind-2.18.2.jar",
    sha256: "4b364e6850dc89172fcf1d4dd26b8ff5488eda44ff4657e22dd265203dd5ab3c",
  },
  {
    path: "test_files/share/junit-platform-console-standalone-1.12.0.jar",
    url: "https://repo.maven.apache.org/maven2/org/junit/platform/junit-platform-console-standalone/1.12.0/junit-platform-console-standalone-1.12.0.jar",
    sha256: "7f66b9410172c0a330e3e5762e534aca8161399671aee311bc60cbd18a53b32d",
  },
  {
    path: "test_files/share/kotlin-stdlib-2.1.10.jar",
    url: "https://repo.maven.apache.org/maven2/org/jetbrains/kotlin/kotlin-stdlib/2.1.10/kotlin-stdlib-2.1.10.jar",
    sha256: "5f2ac1ca8dc8b37a3f4314e716d36969ebf0227a75181d32699d0a8f645b1c21",
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(path) {
  return sha256(await readFile(path));
}

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    ...(options.capture
      ? { encoding: "utf8" }
      : { stdio: "inherit" }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}.`);
  }
  return options.capture
    ? `${result.stdout ?? ""}${result.stderr ?? ""}`
    : undefined;
}

async function materializeMavenFixture(fixture) {
  const destination = join(testRoot, fixture.path);
  if (await exists(destination)) {
    const digest = await fileSha256(destination);
    if (digest === fixture.sha256) return;
  }
  const response = await fetch(fixture.url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`Failed to download ${fixture.url}: HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== fixture.sha256) {
    throw new Error(
      `Downloaded fixture digest mismatch for ${fixture.path}: expected ${fixture.sha256}, received ${digest}.`,
    );
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, destination);
}

async function materializePlatformJar() {
  const packageManifest = JSON.parse(
    await readFile(join(root, "runtime-release", "manifest.json"), "utf8"),
  );
  const identity = packageManifest.files?.find(
    (file) => file.path === "profiles/core/jdk23.jar",
  );
  if (!identity?.sha256) {
    throw new Error("The package runtime manifest does not declare profiles/core/jdk23.jar.");
  }
  const source = join(root, "runtime", "assets", "profiles", "core", "jdk23.jar");
  if (!(await exists(source))) {
    run(process.execPath, [join(root, "scripts", "materialize-package-runtime.mjs")]);
  }
  const sourceDigest = await fileSha256(source);
  if (sourceDigest !== identity.sha256) {
    throw new Error("The materialized Java 23 platform JAR does not match the package manifest.");
  }
  const destination = join(testRoot, "jdk23.jar");
  await copyFile(source, destination);
}

async function buildJar(javaHome, sourcePath, destination) {
  const temporary = await mkdtemp(join(tmpdir(), "tracejvm-test-fixture-"));
  try {
    run(join(javaHome, "bin", "javac"), [
      "--release",
      "23",
      "-g:source,lines",
      "-d",
      temporary,
      sourcePath,
    ]);
    await mkdir(dirname(destination), { recursive: true });
    run(join(javaHome, "bin", "jar"), [
      "--create",
      "--file",
      destination,
      "--no-manifest",
      `--date=${fixedJarDate}`,
      "-C",
      temporary,
      ".",
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function materializeProjectFixtures() {
  const javaHome = process.env.TRACEJVM_JAVA23_HOME;
  if (!javaHome) {
    throw new Error(
      "TRACEJVM_JAVA23_HOME is required to build the Java 23 test fixtures. Run pnpm bootstrap:toolchain or point it at a pinned JDK 23 installation.",
    );
  }
  const javac = join(javaHome, "bin", "javac");
  if (!(await exists(javac))) {
    throw new Error(`TRACEJVM_JAVA23_HOME does not contain bin/javac: ${javaHome}`);
  }
  const expectedVersion = runtimeManifest.buildTools?.hostJdk?.version;
  const runtimeVersion = run(
    join(javaHome, "bin", "java"),
    ["-XshowSettings:properties", "-version"],
    { capture: true },
  );
  if (
    !expectedVersion ||
    !runtimeVersion.includes(`java.runtime.version = ${expectedVersion}`) ||
    !runtimeVersion.includes(`java.vendor.version = Temurin-${expectedVersion}`)
  ) {
    throw new Error(
      `TRACEJVM_JAVA23_HOME must be the pinned Eclipse Temurin ${String(expectedVersion)} JDK from runtime/manifest.json.`,
    );
  }
  await buildJar(
    javaHome,
    join(testRoot, "test_files", "basic_classloader", "ExternalClass.java"),
    join(testRoot, "test_files", "basic_classloader", "external.jar"),
  );
  await buildJar(
    javaHome,
    join(testRoot, "test_files", "intact_jar", "Main.java"),
    join(testRoot, "test_files", "intact_jar", "ok.jar"),
  );
  await buildJar(
    javaHome,
    join(testRoot, "test_files", "url-classloader", "DynamicallyLoaded.java"),
    join(testRoot, "test_files", "url-classloader", "test.jar"),
  );
  const brokenJar = join(
    testRoot,
    "test_files",
    "broken_jar",
    "this_is_a_jar.jar",
  );
  await mkdir(dirname(brokenJar), { recursive: true });
  await writeFile(
    brokenJar,
    "This is intentionally not a ZIP archive.\n",
    { mode: 0o644 },
  );
}

await Promise.all(mavenFixtures.map(materializeMavenFixture));
await materializePlatformJar();
await materializeProjectFixtures();
console.log(`Materialized ${mavenFixtures.length + 5} verified TraceJVM test fixtures.`);
