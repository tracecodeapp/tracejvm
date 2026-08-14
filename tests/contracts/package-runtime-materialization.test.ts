import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  createTraceJVMRuntimeArchive,
  TRACEJVM_RUNTIME_ARCHIVE_FORMAT,
} from "../../runtime-package-archive.mjs";
import { materializeTraceJVMPackageRuntime } from "../../scripts/materialize-package-runtime.mjs";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the committed package archive materializes clean runtime test inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracejvm-package-runtime-"));
  try {
    const sourceRoot = join(root, "fixture");
    const fixture = new Map<string, Buffer>([
      ["bjvm_main.wasm", Buffer.from([0, 97, 115, 109])],
      ["compiler/manifest.json", Buffer.from("{}\n")],
      ["compiler/compiler.wasm", Buffer.from([0, 97, 115, 109])],
      ["profiles/core/jdk23.jar", Buffer.from("core")],
      ["profiles/server/jdk23.jar", Buffer.from("server")],
      ["profiles/spring-server/jdk23.jar", Buffer.from("spring")],
    ]);
    const files = [...fixture].map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    }));
    for (const [path, bytes] of fixture) {
      const outputPath = join(sourceRoot, ...path.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
    }

    const packageRoot = join(root, "runtime-release");
    const archiveName = "fixture.tar.zst";
    const archive = await createTraceJVMRuntimeArchive({
      sourceRoot,
      files,
      outputPath: join(packageRoot, archiveName),
    });
    await writeFile(
      join(packageRoot, "manifest.json"),
      `${JSON.stringify({
        schema: "tracejvm-package-runtime-v1",
        releaseId: "tracejvm@test",
        archive: {
          path: archiveName,
          format: TRACEJVM_RUNTIME_ARCHIVE_FORMAT,
          size: archive.size,
          sha256: archive.sha256,
          integrity: archive.integrity,
        },
        files,
      })}\n`,
    );
    await mkdir(join(root, "runtime", "assets"), { recursive: true });
    await writeFile(join(root, "runtime", "assets", "stale.bin"), "stale");
    await mkdir(join(root, ".cache", "teavm-javac", "artifacts"), {
      recursive: true,
    });
    await writeFile(
      join(root, ".cache", "teavm-javac", "artifacts", "stale.bin"),
      "stale",
    );

    await materializeTraceJVMPackageRuntime({ root });

    assert.deepEqual(
      await readFile(join(root, "runtime", "assets", "bjvm_main.wasm")),
      fixture.get("bjvm_main.wasm"),
    );
    assert.deepEqual(
      await readFile(
        join(root, ".cache", "teavm-javac", "artifacts", "compiler.wasm"),
      ),
      fixture.get("compiler/compiler.wasm"),
    );
    assert.equal(existsSync(join(root, "runtime", "assets", "stale.bin")), false);
    assert.equal(
      existsSync(join(root, ".cache", "teavm-javac", "artifacts", "stale.bin")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
