#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const sourceManifestPath = join(
  root,
  "compiler/teavm-javac/manifest.json",
);
const artifactsRoot = join(
  root,
  ".cache/teavm-javac/artifacts",
);
const artifactManifestPath = join(artifactsRoot, "manifest.json");
const mode = process.argv[2] ?? "verify";

assert.ok(
  mode === "write" || mode === "verify",
  "Usage: teavm-javac-artifacts.mjs [write|verify]",
);

const sourceManifestContent = readFileSync(sourceManifestPath);
const source = JSON.parse(sourceManifestContent.toString("utf8"));

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function inspectArtifacts() {
  return source.artifacts.map((name) => {
    const path = join(artifactsRoot, name);
    const content = readFileSync(path);
    assert.ok(content.byteLength > 0, `${name} must not be empty`);
    return {
      name,
      bytes: content.byteLength,
      sha256: digest(content),
    };
  });
}

function assertMagic(name, expected) {
  const content = readFileSync(join(artifactsRoot, name));
  assert.equal(
    content.subarray(0, expected.length).equals(Buffer.from(expected)),
    true,
    `${name} has an invalid file signature`,
  );
}

if (mode === "write") {
  const manifest = {
    schema: "tracejvm.teavm-javac-artifacts.v1",
    sourceManifestSha256: digest(sourceManifestContent),
    upstreamCommit: source.upstream.commit,
    jdk: {
      version: source.jdk.version,
      revision: source.jdk.revision,
      classFileMajor: source.jdk.classFileMajor,
    },
    files: inspectArtifacts(),
  };
  writeFileSync(
    artifactManifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

const manifest = JSON.parse(readFileSync(artifactManifestPath, "utf8"));
assert.equal(manifest.schema, "tracejvm.teavm-javac-artifacts.v1");
assert.equal(manifest.sourceManifestSha256, digest(sourceManifestContent));
assert.equal(manifest.upstreamCommit, source.upstream.commit);
assert.deepEqual(manifest.jdk, {
  version: source.jdk.version,
  revision: source.jdk.revision,
  classFileMajor: source.jdk.classFileMajor,
});
assert.deepEqual(manifest.files, inspectArtifacts());
assert.equal(statSync(artifactManifestPath).isFile(), true);
assertMagic("compiler.wasm", [0x00, 0x61, 0x73, 0x6d]);
assertMagic(
  "compiler.wasm-deobfuscator.wasm",
  [0x00, 0x61, 0x73, 0x6d],
);

const totalBytes = manifest.files.reduce(
  (total, file) => total + file.bytes,
  0,
);
console.log(
  `PASS: verified ${manifest.files.length} TeaVM javac artifacts ` +
    `(${totalBytes} bytes, OpenJDK ${source.jdk.version}, ` +
    `classfile ${source.jdk.classFileMajor})`,
);
