import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createTraceJVMAssetIntegrityMap,
  fetchVerifiedTraceJVMAsset,
  importVerifiedTraceJVMModule,
} from "../../src/asset-integrity";

function integrity(content: string): { size: number; sha256: string } {
  const bytes = new TextEncoder().encode(content);
  return {
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("verified asset loading accepts only the pinned bytes", async () => {
  const url = "data:application/octet-stream,verified";
  const assets = { [url]: integrity("verified") };
  assert.equal(
    new TextDecoder().decode(await fetchVerifiedTraceJVMAsset(url, assets)),
    "verified",
  );
  await assert.rejects(
    fetchVerifiedTraceJVMAsset(
      "data:application/octet-stream,tampered",
      { "data:application/octet-stream,tampered": integrity("verified") },
    ),
    /size mismatch|SHA-256 mismatch/,
  );
});

test("verified module loading executes only after SHA-256 validation", async () => {
  const source = "export const answer = 42;";
  const url = `data:text/javascript,${encodeURIComponent(source)}`;
  const module = await importVerifiedTraceJVMModule<{ answer: number }>(
    url,
    { [url]: integrity(source) },
  );
  assert.equal(module.answer, 42);
  await assert.rejects(
    importVerifiedTraceJVMModule(url, {
      [url]: { ...integrity(source), sha256: "0".repeat(64) },
    }),
    /SHA-256 mismatch/,
  );
});

test("release inventories produce exact URL-keyed integrity maps", () => {
  assert.deepEqual(
    { ...createTraceJVMAssetIntegrityMap("https://assets.example/release/", [
      { path: "profiles/core/jdk23.jar", ...integrity("jar") },
    ]) },
    {
      "https://assets.example/release/profiles/core/jdk23.jar":
        integrity("jar"),
    },
  );
  assert.throws(
    () => createTraceJVMAssetIntegrityMap("/runtime", [
      { path: "../escape", ...integrity("bad") },
    ]),
    /Invalid TraceJVM release asset path/,
  );
});
