#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractTraceJVMRuntimeArchive,
  TRACEJVM_RUNTIME_ARCHIVE_FORMAT,
} from "../runtime-package-archive.mjs";

const TRACEJVM_PACKAGE_RUNTIME_SCHEMA = "tracejvm-package-runtime-v1";
const REQUIRED_RUNTIME_PATHS = [
  "bjvm_main.wasm",
  "compiler/manifest.json",
  "profiles/core/jdk23.jar",
  "profiles/server/jdk23.jar",
  "profiles/spring-server/jdk23.jar",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPackageManifest(manifest) {
  if (
    manifest?.schema !== TRACEJVM_PACKAGE_RUNTIME_SCHEMA ||
    manifest.archive?.format !== TRACEJVM_RUNTIME_ARCHIVE_FORMAT ||
    typeof manifest.archive?.path !== "string" ||
    basename(manifest.archive.path) !== manifest.archive.path ||
    !Number.isSafeInteger(manifest.archive?.size) ||
    manifest.archive.size <= 0 ||
    !/^[0-9a-f]{64}$/u.test(manifest.archive?.sha256 ?? "") ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("TraceJVM package runtime manifest is invalid.");
  }
  const paths = new Set(manifest.files.map((file) => file?.path));
  for (const requiredPath of REQUIRED_RUNTIME_PATHS) {
    if (!paths.has(requiredPath)) {
      throw new Error(`TraceJVM package runtime is missing ${requiredPath}.`);
    }
  }
}

async function replaceDirectory(stage, target) {
  await rm(target, { recursive: true, force: true });
  await rename(stage, target);
}

export async function materializeTraceJVMPackageRuntime(options = {}) {
  const root = options.root ?? join(import.meta.dirname, "..");
  const packageRoot = join(root, "runtime-release");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "manifest.json"), "utf8"),
  );
  assertPackageManifest(manifest);

  const archivePath = join(packageRoot, manifest.archive.path);
  const archiveBytes = await readFile(archivePath);
  const archiveDigest = sha256(archiveBytes);
  const archiveIntegrity = `sha256-${Buffer.from(archiveDigest, "hex").toString("base64")}`;
  if (
    archiveBytes.byteLength !== manifest.archive.size ||
    archiveDigest !== manifest.archive.sha256 ||
    archiveIntegrity !== manifest.archive.integrity
  ) {
    throw new Error("TraceJVM package runtime archive failed verification.");
  }

  const cacheRoot = join(root, ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const extractionRoot = await mkdtemp(join(cacheRoot, "package-runtime-"));
  const runtimeTarget = join(root, "runtime", "assets");
  const compilerTarget = join(root, ".cache", "teavm-javac", "artifacts");
  const runtimeStage = `${runtimeTarget}.stage-${process.pid}-${Date.now()}`;
  const compilerStage = `${compilerTarget}.stage-${process.pid}-${Date.now()}`;

  try {
    await extractTraceJVMRuntimeArchive({
      archivePath,
      destination: extractionRoot,
      files: manifest.files,
    });

    await mkdir(runtimeStage, { recursive: true });
    await rename(join(extractionRoot, "bjvm_main.wasm"), join(runtimeStage, "bjvm_main.wasm"));
    await rename(join(extractionRoot, "profiles"), join(runtimeStage, "profiles"));
    await mkdir(dirname(compilerStage), { recursive: true });
    await rename(join(extractionRoot, "compiler"), compilerStage);

    await replaceDirectory(runtimeStage, runtimeTarget);
    await replaceDirectory(compilerStage, compilerTarget);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
    await rm(runtimeStage, { recursive: true, force: true });
    await rm(compilerStage, { recursive: true, force: true });
  }

  if (!(await stat(join(runtimeTarget, "bjvm_main.wasm"))).isFile()) {
    throw new Error("TraceJVM package runtime materialization failed.");
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await materializeTraceJVMPackageRuntime();
    console.log(
      `Materialized ${manifest.releaseId} from its verified package archive.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
