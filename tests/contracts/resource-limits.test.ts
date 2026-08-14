import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTraceJVMResourceLimits,
  TraceJVMOutputBudget,
  utf8ByteLength,
  validateTraceJVMCompileResources,
  validateTraceJVMRunResources,
} from "../../src/resource-limits";

test("request limits reject oversized aggregate and individual inputs", () => {
  const limits = {
    maxInputFiles: 3,
    maxInputBytes: 8,
    maxFileBytes: 6,
    maxOutputBytes: 8,
  };
  assert.throws(
    () => validateTraceJVMCompileResources({
      sources: [{ path: "Main.java", content: "1234567" }],
    }, limits),
    /per-file limit/,
  );
  assert.throws(
    () => validateTraceJVMRunResources({
      program: {
        files: [{ path: "Main.class", content: new Uint8Array(5) }],
      },
      classpath: [{ path: "helper.jar", content: new Uint8Array(4) }],
      mainClass: "M",
    }, limits),
    /payload exceeds/,
  );
  assert.throws(
    () => validateTraceJVMRunResources({
      program: {
        files: [
          { path: "A.class", content: new Uint8Array(1) },
          { path: "B.class", content: new Uint8Array(1) },
          { path: "C.class", content: new Uint8Array(1) },
        ],
      },
      mainClass: "M",
    }, limits),
    /4 payload entries/,
  );
});

test("request limits include arguments and system properties", () => {
  const limits = {
    maxInputFiles: 4,
    maxInputBytes: 8,
    maxFileBytes: 10,
    maxOutputBytes: 8,
  };
  assert.throws(() => validateTraceJVMRunResources({
    program: { files: [] },
    mainClass: "M",
    args: ["1234"],
    systemProperties: { key: "value" },
  }, limits), /payload exceeds/);
});

test("request limits preserve bounded Unicode and binary inputs", () => {
  const limits = {
    maxInputFiles: 2,
    maxInputBytes: 12,
    maxFileBytes: 8,
    maxOutputBytes: 8,
  };
  assert.equal(utf8ByteLength("A😀"), 5);
  assert.doesNotThrow(() => validateTraceJVMCompileResources({
    sources: [{ path: "Main.java", content: "A😀" }],
    classpath: [{ path: "helper.jar", content: new Uint8Array(7) }],
  }, limits));
  assert.deepEqual(resolveTraceJVMResourceLimits(limits), limits);
});

test("output budgets reject accumulation beyond the configured ceiling", () => {
  const budget = new TraceJVMOutputBudget(5);
  budget.consume("A");
  budget.consume("😀");
  assert.throws(() => budget.consume("!"), /output exceeds 5 bytes/);
});
