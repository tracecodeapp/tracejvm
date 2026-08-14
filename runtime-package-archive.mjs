import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  constants as zlibConstants,
  createZstdCompress,
  createZstdDecompress,
} from "node:zlib";
import { extract, pack } from "tar-stream";

export const TRACEJVM_RUNTIME_ARCHIVE_FORMAT = "tar+zstd-v1";

function isSafeRelativePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function archiveFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("TraceJVM runtime archive requires a non-empty file inventory.");
  }
  const seen = new Set();
  return [...files]
    .sort((left, right) => compareText(left.path, right.path))
    .map((file) => {
      if (
        !isSafeRelativePath(file?.path) ||
        seen.has(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !/^[0-9a-f]{64}$/u.test(file.sha256 ?? "")
      ) {
        throw new Error(`TraceJVM runtime archive entry is invalid: ${String(file?.path)}.`);
      }
      seen.add(file.path);
      return file;
    });
}

export async function createTraceJVMRuntimeArchive({ sourceRoot, files, outputPath }) {
  const declaredFiles = archiveFiles(files);
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(outputPath), { recursive: true });
  const archive = pack();
  const compressed = createZstdCompress({
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: 9,
      [zlibConstants.ZSTD_c_enableLongDistanceMatching]: 1,
      [zlibConstants.ZSTD_c_windowLog]: 27,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
    },
  });
  const completion = pipeline(archive, compressed, createWriteStream(temporaryPath, { flags: "wx" }));
  try {
    for (const file of declaredFiles) {
      const bytes = await readFile(join(sourceRoot, ...file.path.split("/")));
      if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
        throw new Error(`TraceJVM runtime asset drifted while archiving: ${file.path}.`);
      }
      await new Promise((resolve, reject) => {
        archive.entry(
          {
            name: file.path,
            size: bytes.byteLength,
            mode: 0o644,
            mtime: new Date(0),
            uid: 0,
            gid: 0,
            uname: "",
            gname: "",
            type: "file",
          },
          bytes,
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
    archive.finalize();
    await completion;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await completion.catch(() => undefined);
    await rm(temporaryPath, { force: true });
    throw error;
  }
  const bytes = await readFile(outputPath);
  const digest = sha256(bytes);
  return {
    path: outputPath,
    format: TRACEJVM_RUNTIME_ARCHIVE_FORMAT,
    size: bytes.byteLength,
    sha256: digest,
    integrity: `sha256-${Buffer.from(digest, "hex").toString("base64")}`,
  };
}

export async function extractTraceJVMRuntimeArchive({ archivePath, destination, files }) {
  const expected = new Map(archiveFiles(files).map((file) => [file.path, file]));
  const unpack = extract();
  unpack.on("entry", (header, stream, next) => {
    void (async () => {
      if (header.type !== "file" || !isSafeRelativePath(header.name)) {
        throw new Error(`TraceJVM runtime archive contains an unsafe entry: ${header.name}.`);
      }
      const declared = expected.get(header.name);
      if (!declared || header.size !== declared.size) {
        throw new Error(`TraceJVM runtime archive contains an undeclared entry: ${header.name}.`);
      }
      expected.delete(header.name);
      const outputPath = join(destination, ...header.name.split("/"));
      await mkdir(dirname(outputPath), { recursive: true });
      const digest = createHash("sha256");
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.byteLength;
        digest.update(chunk);
      });
      await pipeline(stream, createWriteStream(outputPath, { flags: "wx", mode: 0o644 }));
      if (size !== declared.size || digest.digest("hex") !== declared.sha256) {
        throw new Error(`TraceJVM runtime archive asset failed verification: ${header.name}.`);
      }
    })().then(() => next(), (error) => next(error));
  });
  await mkdir(destination, { recursive: true });
  await pipeline(createReadStream(archivePath), createZstdDecompress(), unpack);
  if (expected.size > 0) {
    throw new Error(
      `TraceJVM runtime archive is missing declared assets: ${[...expected.keys()].join(", ")}.`,
    );
  }
  return destination;
}
