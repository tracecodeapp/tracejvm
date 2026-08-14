#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACEJVM_RUNTIME_CACHE_CONTROL } from "./runtime-release-lib.mjs";
import {
  extractTraceJVMRuntimeArchive,
  TRACEJVM_RUNTIME_ARCHIVE_FORMAT,
} from "../runtime-package-archive.mjs";

const root = join(import.meta.dirname, "..");
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const license = readFileSync(join(root, "LICENSE"), "utf8");
const requiredFiles = [
  "dist/browser-client.js",
  "dist/browser-worker.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/worker-protocol.js",
  "dist/worker-protocol.d.ts",
];
const packageRuntime = JSON.parse(
  readFileSync(join(root, "runtime-release", "manifest.json"), "utf8"),
);

assert.deepEqual(
  packageJson.files,
  [
    "dist",
    "runtime-release/manifest.json",
    "runtime-release/*.tar.zst",
    "runtime-package-archive.mjs",
    "runtime-package-archive.d.mts",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
  ],
  "The npm package must contain the API and its exact browser runtime release.",
);
assert.equal(packageJson.license, "AGPL-3.0-only");
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/u);
assert.match(license, /Version 3, 19 November 2007/u);
assert.match(license, /END OF TERMS AND CONDITIONS/u);
assert.equal(
  packageRuntime.schema,
  "tracejvm-package-runtime-v1",
  "The npm runtime manifest must use the supported schema.",
);
assert.equal(packageRuntime.package?.name, packageJson.name);
assert.equal(packageRuntime.package?.version, packageJson.version);
assert.equal(
  packageRuntime.relativePrefix,
  `tracejvm/${packageJson.version}/${packageRuntime.contentHash}`,
);
assert.ok(packageRuntime.files.length > 0, "The npm runtime manifest cannot be empty.");
assert.equal(
  packageRuntime.files.find((file) => file.path === "release.json")
    ?.cacheControl,
  TRACEJVM_RUNTIME_CACHE_CONTROL,
  "The packaged release descriptor must inherit the immutable runtime cache policy.",
);
for (const legalPath of [
  "legal/B-JVM-MIT.txt",
  "legal/OPENJDK-COMPILER-GPL-2.0-WITH-CLASSPATH-EXCEPTION.txt",
  "legal/TEAVM-JAVAC-APACHE-2.0.txt",
  "legal/TEMURIN-23.0.2+7-NOTICE.txt",
  "legal/THIRD_PARTY_NOTICES.md",
  "legal/TRACEJVM-AGPL-3.0.txt",
]) {
  assert.ok(
    packageRuntime.files.some((file) => file.path === legalPath),
    `The npm runtime is missing required legal material: ${legalPath}`,
  );
}
assert.equal(
  packageRuntime.files.some((file) => file.path.startsWith("source/")),
  false,
  "Corresponding-source archives belong to the immutable hosted release, not the npm tarball.",
);
assert.equal(packageJson.private, undefined, "The npm package must be publishable.");
assert.equal(
  packageJson.publishConfig?.access,
  "public",
  "The scoped npm package must publish with public access.",
);
for (const relativePath of requiredFiles) {
  assert.ok(
    existsSync(join(root, relativePath)),
    `Missing built package artifact: ${relativePath}`,
  );
}
assert.equal(packageRuntime.archive?.format, TRACEJVM_RUNTIME_ARCHIVE_FORMAT);
assert.equal(
  packageRuntime.archive?.path,
  `tracejvm-${packageJson.version}-${packageRuntime.contentHash}.tar.zst`,
);
const archivePath = join(root, "runtime-release", packageRuntime.archive.path);
const archiveBytes = readFileSync(archivePath);
assert.equal(archiveBytes.byteLength, packageRuntime.archive.size);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
assert.equal(
  archiveSha256,
  packageRuntime.archive.sha256,
  "The npm runtime archive digest drifted.",
);
assert.equal(
  packageRuntime.archive.integrity,
  `sha256-${Buffer.from(archiveSha256, "hex").toString("base64")}`,
  "The npm runtime archive integrity metadata drifted.",
);
const extractedRoot = mkdtempSync(join(tmpdir(), "tracejvm-package-verify-"));
try {
  await extractTraceJVMRuntimeArchive({
    archivePath,
    destination: extractedRoot,
    files: packageRuntime.files,
  });
  for (const entrypoint of ["browser-client.js", "browser-worker.js"]) {
    assert.deepEqual(
      readFileSync(join(root, "dist", entrypoint)),
      readFileSync(join(extractedRoot, entrypoint)),
      `Built ${entrypoint} must be byte-identical to the packaged runtime entrypoint.`,
    );
  }
} finally {
  rmSync(extractedRoot, { recursive: true, force: true });
}
assert.equal(
  existsSync(
    join(
      root,
      "runtime-release",
      packageJson.version,
      packageRuntime.contentHash,
    ),
  ),
  false,
  "The expanded runtime must not remain beside its canonical package archive.",
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(
  npm,
  ["pack", "--ignore-scripts", "--dry-run", "--json"],
  {
  cwd: root,
  encoding: "utf8",
  },
);
if (packed.error) throw packed.error;
if (packed.status !== 0) {
  throw new Error(
    `npm pack --dry-run failed:\n${packed.stderr || packed.stdout}`,
  );
}

const reports = JSON.parse(packed.stdout);
assert.equal(reports.length, 1, "Expected one npm package report.");
const report = reports[0];
const paths = report.files.map(({ path }) => path);
for (const required of [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  ...requiredFiles,
  "runtime-release/manifest.json",
  `runtime-release/${packageRuntime.archive.path}`,
  "runtime-package-archive.mjs",
  "runtime-package-archive.d.mts",
]) {
  assert.ok(paths.includes(required), `Packed artifact is missing ${required}`);
}
for (const prohibitedPrefix of [
  "engine/",
  "tests/",
  "compatibility/",
  "reports/",
  ".cache/",
]) {
  assert.equal(
    paths.some((path) => path.startsWith(prohibitedPrefix)),
    false,
    `Packed artifact leaked ${prohibitedPrefix}`,
  );
}
assert.equal(
  paths.some((path) => path.startsWith(`runtime-release/${packageJson.version}/`)),
  false,
  "Expanded runtime files must travel inside the verified archive rather than the npm tarball.",
);
const packagedCode = paths
  .filter(
    (path) =>
      path.startsWith("dist/") &&
      (path.endsWith(".js") || path.endsWith(".d.ts")),
  )
  .map((path) => readFileSync(join(root, path), "utf8"))
  .join("\n");
assert.doesNotMatch(
  packagedCode,
  /\bBovine[A-Za-z0-9_]*/u,
  "Packed artifacts leaked the obsolete Bovine implementation identity",
);
assert.ok(
  report.size < 95_000_000,
  `TraceJVM npm tarball exceeded the 95 MB release ceiling: ${report.size} bytes`,
);

console.log(
  `PASS: ${report.id} packs ${report.files.length} files ` +
    `(${report.size} bytes compressed, ${report.unpackedSize} bytes unpacked) ` +
    `with ${packageRuntime.releaseId}`,
);
