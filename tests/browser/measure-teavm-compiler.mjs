import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT ?? 8780);
const selected = (process.env.BROWSERS ?? "chromium,firefox,webkit")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const samples = Number(process.env.SAMPLES ?? 6);
const outputPath = process.argv[2] ??
  join(root, "reports", "teavm-compiler-v03.json");
const browsers = { chromium, firefox, webkit };

function source(variant) {
  return `public final class CompilerMatrixProbe {
    sealed interface Value permits NumberValue, TextValue {}
    record NumberValue(int value) implements Value {}
    record TextValue(String value) implements Value {}
    static int lower(Value value) {
      return switch (value) {
        case NumberValue(var number) -> number + ${variant};
        case TextValue(var text) -> text.length();
      };
    }
  }`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const server = spawn(process.execPath, [join(root, "tests/browser/serve.mjs")], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM compiler measurement host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM compiler measurement host exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("compatibility host")) {
      clearTimeout(timeout);
      resolve();
    }
  });
});

try {
  const results = [];
  for (const name of selected) {
    const browserType = browsers[name];
    if (!browserType) throw new Error(`Unknown browser: ${name}`);
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
      await page.waitForFunction(() => "traceJVMTest" in globalThis);
      const result = await page.evaluate(
        async ({ sources }) => {
          const initialized =
            await globalThis.traceJVMTest.initializeSplitCompiler();
          const compileMs = [];
          const artifactBytes = [];
          for (const content of sources) {
            const compiled =
              await globalThis.traceJVMTest.compileSplitProgram([{
                path: "CompilerMatrixProbe.java",
                content,
              }]);
            if (compiled.status !== "completed") {
              throw new Error(
                `TeaVM compiler failed: ${compiled.stderr}`,
              );
            }
            compileMs.push(compiled.timings.totalMs);
            artifactBytes.push(compiled.artifactBytes);
          }
          globalThis.traceJVMTest.disposeSplitCompiler();
          return {
            initializeMs: initialized.initializeMs,
            compileMs,
            artifactBytes,
          };
        },
        {
          sources: Array.from({ length: samples }, (_, index) => source(index)),
        },
      );
      assert.equal(result.compileMs.length, samples, name);
      assert.ok(result.artifactBytes.every((bytes) => bytes > 0), name);
      const warm = result.compileMs.slice(1);
      results.push({
        browser: name,
        initializeMs: result.initializeMs,
        firstCompileMs: result.compileMs[0],
        warmCompileMs: warm,
        warmMedianMs: median(warm),
        artifactBytes: result.artifactBytes,
      });
    } finally {
      await browser.close();
    }
  }
  const report = {
    schema: "tracejvm.teavm-compiler-performance.v1",
    measuredAt: new Date().toISOString(),
    samples,
    results,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.kill();
}
