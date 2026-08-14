#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareTraceJVMRuntimeRelease,
  TRACEJVM_RUNTIME_CACHE_CONTROL,
} from "./runtime-release-lib.mjs";
import {
  createTraceJVMRuntimeArchive,
  TRACEJVM_RUNTIME_ARCHIVE_FORMAT,
} from "../runtime-package-archive.mjs";

export const TRACEJVM_PACKAGE_RUNTIME_SCHEMA =
  "tracejvm-package-runtime-v1";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPackageRuntimePath(path) {
  // License and notice files travel with every copy of the runtime. The much
  // larger corresponding-source archives remain on the immutable hosted
  // release described by release.json.
  return !path.startsWith("source/");
}

function readExistingManifest(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function reuseArchive(packageRoot, manifest, expected) {
  if (
    manifest?.schema !== TRACEJVM_PACKAGE_RUNTIME_SCHEMA ||
    manifest.releaseId !== expected.releaseId ||
    manifest.contentHash !== expected.contentHash ||
    manifest.relativePrefix !== expected.relativePrefix ||
    JSON.stringify(manifest.descriptor) !== JSON.stringify(expected.descriptor) ||
    JSON.stringify(manifest.files) !== JSON.stringify(expected.files) ||
    manifest.archive?.path !== expected.archiveName ||
    manifest.archive?.format !== TRACEJVM_RUNTIME_ARCHIVE_FORMAT ||
    !Number.isSafeInteger(manifest.archive?.size) ||
    !/^[0-9a-f]{64}$/u.test(manifest.archive?.sha256 ?? "")
  ) {
    return undefined;
  }
  const archivePath = join(packageRoot, expected.archiveName);
  if (!existsSync(archivePath)) return undefined;
  const bytes = readFileSync(archivePath);
  const digest = sha256(bytes);
  const integrity = `sha256-${Buffer.from(digest, "hex").toString("base64")}`;
  if (
    bytes.byteLength !== manifest.archive.size ||
    digest !== manifest.archive.sha256 ||
    integrity !== manifest.archive.integrity
  ) {
    return undefined;
  }
  return manifest.archive;
}

function removeStalePackageRuntimeEntries(packageRoot, archiveName) {
  for (const entry of readdirSync(packageRoot)) {
    if (entry === archiveName || entry === "manifest.json") continue;
    rmSync(join(packageRoot, entry), { recursive: true, force: true });
  }
}

export async function prepareTraceJVMPackageRuntime(options = {}) {
  const root = options.root ?? join(import.meta.dirname, "..");
  const release = prepareTraceJVMRuntimeRelease({ root });
  const packageRoot = join(root, "runtime-release");
  mkdirSync(packageRoot, { recursive: true });

  const files = release.descriptor.files
    .filter((file) => isPackageRuntimePath(file.path))
    .map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      integrity: file.integrity,
      contentType: file.contentType,
      cacheControl: file.cacheControl,
    }));

  const descriptorBytes = readFileSync(release.descriptorPath);
  files.push({
    path: "release.json",
    size: descriptorBytes.byteLength,
    sha256: sha256(descriptorBytes),
    integrity: `sha256-${createHash("sha256").update(descriptorBytes).digest("base64")}`,
    contentType: "application/json; charset=utf-8",
    cacheControl: TRACEJVM_RUNTIME_CACHE_CONTROL,
  });
  files.sort((left, right) => compareText(left.path, right.path));

  const archiveName = `tracejvm-${release.version}-${release.contentHash}.tar.zst`;
  const releaseId = `tracejvm@${release.version}+sha256.${release.contentHash}`;
  const descriptor = {
    path: `${release.version}/${release.contentHash}/release.json`,
    size: descriptorBytes.byteLength,
    sha256: sha256(descriptorBytes),
  };
  const existingManifest = readExistingManifest(join(packageRoot, "manifest.json"));
  const reusedArchive = reuseArchive(packageRoot, existingManifest, {
    releaseId,
    contentHash: release.contentHash,
    relativePrefix: release.relativePrefix,
    descriptor,
    files,
    archiveName,
  });
  let archive = reusedArchive;
  if (!archive) {
    const outputPath = join(packageRoot, archiveName);
    rmSync(outputPath, { force: true });
    archive = await createTraceJVMRuntimeArchive({
      sourceRoot: release.outputDirectory,
      files,
      outputPath,
    });
  }

  const manifest = {
    schema: TRACEJVM_PACKAGE_RUNTIME_SCHEMA,
    package: release.descriptor.package,
    releaseId,
    contentHash: release.contentHash,
    relativePrefix: release.relativePrefix,
    targetPath: `java/${release.relativePrefix}`,
    descriptor,
    archive: {
      path: archiveName,
      format: archive.format,
      size: archive.size,
      sha256: archive.sha256,
      integrity: archive.integrity,
    },
    files,
  };
  removeStalePackageRuntimeEntries(packageRoot, archiveName);
  writeFileSync(
    join(packageRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await prepareTraceJVMPackageRuntime();
    console.log(
      `Prepared ${manifest.releaseId} for npm (${manifest.files.length} files).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
