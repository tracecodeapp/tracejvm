import assert from "node:assert/strict";
import test from "node:test";

import {
  validateProcessFilePath,
  validateRelativePath,
} from "../../src/path-validation";

test("relative VM paths reject aliases and traversal", () => {
  for (const path of [
    "io//tracecode/tracekernel/TraceKernel.class",
    "io/tracecode/tracekernel/./TraceKernel.class",
    "io/tracecode/tracekernel/../TraceKernel.class",
    "/io/tracecode/TraceKernel.class",
    "io\\tracecode\\TraceKernel.class",
  ]) {
    assert.throws(() => validateRelativePath(path, "Java classpath"));
  }
  assert.doesNotThrow(() =>
    validateRelativePath("com/example/Main.class", "Java classpath")
  );
});

test("process files cannot alias reserved VM roots", () => {
  for (const path of [
    "//tracejvm/runtime.class",
    "/workspace//tracejvm/runtime.class",
    "/workspace/../tracejvm/runtime.class",
    "/workspace/./tracejvm/runtime.class",
    "/tracejvm/runtime.class",
    "/tracekernel-api/TraceKernel.class",
  ]) {
    assert.throws(() => validateProcessFilePath(path));
  }
  assert.doesNotThrow(() => validateProcessFilePath("/workspace/input.txt"));
});
