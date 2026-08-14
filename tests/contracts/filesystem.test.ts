import assert from "node:assert/strict";
import test from "node:test";

import {
  removeTreeNoFollow,
  type TraceJVMFileSystem,
} from "../../src/filesystem";

const DIRECTORY = 0x4000;
const FILE = 0x8000;
const LINK = 0xa000;

test("scratch cleanup unlinks symlinks without traversing them", () => {
  const nodes = new Map<string, number>([
    ["/scratch", DIRECTORY],
    ["/scratch/classes", DIRECTORY],
    ["/scratch/classes/Main.class", FILE],
    ["/scratch/escape", LINK],
    ["/tracekernel-api", DIRECTORY],
    ["/tracekernel-api/TraceKernel.class", FILE],
  ]);
  const traversed: string[] = [];
  const fs: TraceJVMFileSystem = {
    lstat(path) {
      const mode = nodes.get(path);
      if (mode === undefined) throw new Error("ENOENT");
      return { mode };
    },
    readdir(path) {
      traversed.push(path);
      if ((nodes.get(path) ?? 0) === LINK) {
        throw new Error("cleanup followed a symlink");
      }
      const prefix = `${path}/`;
      return [
        ".",
        "..",
        ...new Set(
          [...nodes.keys()]
            .filter((candidate) => candidate.startsWith(prefix))
            .map((candidate) => candidate.slice(prefix.length).split("/")[0]),
        ),
      ];
    },
    unlink(path) {
      nodes.delete(path);
    },
    rmdir(path) {
      nodes.delete(path);
    },
  };

  removeTreeNoFollow(fs, "/scratch");

  assert.equal(nodes.has("/scratch"), false);
  assert.equal(nodes.has("/scratch/escape"), false);
  assert.equal(nodes.has("/tracekernel-api/TraceKernel.class"), true);
  assert.equal(traversed.includes("/scratch/escape"), false);
});
