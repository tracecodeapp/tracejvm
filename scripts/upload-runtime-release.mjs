#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  contentTypeForTraceJVMAsset,
  normalizeTraceJVMReleasePath,
  prepareTraceJVMRuntimeRelease,
  TRACEJVM_RUNTIME_CACHE_CONTROL,
  TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
  verifyTraceJVMRuntimeRelease,
} from "./runtime-release-lib.mjs";

const WRANGLER = fileURLToPath(import.meta.resolve("wrangler"));
const EMPTY_ENV_FILE = process.platform === "win32" ? "NUL" : "/dev/null";

function parseArgs(argv) {
  const options = {
    bucket: process.env.TRACEJVM_RUNTIME_BUCKET ?? null,
    releaseDirectory: null,
    dryRun: false,
    local: false,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--local") options.local = true;
    else if (arg.startsWith("--bucket=")) {
      options.bucket = arg.slice("--bucket=".length);
    } else if (arg.startsWith("--release-dir=")) {
      options.releaseDirectory = arg.slice("--release-dir=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.bucket) {
    throw new Error(
      "An R2 bucket is required. Pass --bucket or set TRACEJVM_RUNTIME_BUCKET.",
    );
  }
  if (!options.bucket.trim() || options.bucket.includes("/")) {
    throw new Error(`Invalid R2 bucket name: ${options.bucket}`);
  }
  return options;
}

function uploadFile({
  bucket,
  prefix,
  releaseDirectory,
  file,
  expectedSha256,
  expectedSize,
  dryRun,
  local,
}) {
  const path = normalizeTraceJVMReleasePath(file.path);
  const normalizedPrefix = normalizeTraceJVMReleasePath(prefix, "R2 prefix");
  const absolutePath = join(releaseDirectory, ...path.split("/"));
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Missing prepared runtime asset: ${absolutePath}`);
  }
  const content = readFileSync(absolutePath);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== expectedSha256 || content.byteLength !== expectedSize) {
    throw new Error(`Prepared runtime asset identity mismatch: ${path}`);
  }
  const args = [
    "r2",
    "object",
    "put",
    `${bucket}/${normalizedPrefix}/${path}`,
    "--file",
    absolutePath,
    "--content-type",
    file.contentType,
    "--cache-control",
    file.cacheControl,
    local ? "--local" : "--remote",
    `--env-file=${EMPTY_ENV_FILE}`,
  ];
  if (dryRun) {
    console.log(
      [process.execPath, WRANGLER, ...args]
        .map((value) => JSON.stringify(value))
        .join(" "),
    );
    return;
  }
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Failed to upload ${path} to R2.`);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const prepared = options.releaseDirectory
    ? {
        outputDirectory: options.releaseDirectory,
        ...verifyTraceJVMRuntimeRelease(options.releaseDirectory),
      }
    : (() => {
        const release = prepareTraceJVMRuntimeRelease();
        return {
          ...release,
          ...verifyTraceJVMRuntimeRelease(release.outputDirectory),
        };
      })();
  const descriptor = prepared.descriptor;

  // The descriptor is the commit marker: publish every payload object first,
  // then expose release.json only after the immutable tree is complete.
  for (const file of descriptor.files) {
    uploadFile({
      bucket: options.bucket,
      prefix: descriptor.relativePrefix,
      releaseDirectory: prepared.outputDirectory,
      file,
      expectedSha256: file.sha256,
      expectedSize: file.size,
      dryRun: options.dryRun,
      local: options.local,
    });
  }
  uploadFile({
    bucket: options.bucket,
    prefix: descriptor.relativePrefix,
    releaseDirectory: prepared.outputDirectory,
    file: {
      path: TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
      contentType: contentTypeForTraceJVMAsset(
        TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
      ),
      cacheControl: TRACEJVM_RUNTIME_CACHE_CONTROL,
    },
    expectedSha256: prepared.descriptorSha256,
    expectedSize: prepared.descriptorSize,
    dryRun: options.dryRun,
    local: options.local,
  });

  console.log(
    `${options.dryRun ? "Planned" : "Uploaded"} ` +
      `${descriptor.files.length + 1} TraceJVM runtime assets at ` +
      `r2://${options.bucket}/${descriptor.relativePrefix}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
