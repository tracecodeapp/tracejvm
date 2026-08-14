import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chromium,
  firefox,
  webkit,
} from "playwright";

const port = Number(process.env.PORT ?? 8776);
const origin = `http://127.0.0.1:${port}`;
const selected = (process.env.BROWSERS ?? "chromium,firefox,webkit").split(",");
const browserTypes = { chromium, firefox, webkit };
const server = spawn(process.execPath, ["tests/browser/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolveStart, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM split test host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM split test host exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("TraceJVM compatibility host")) {
      clearTimeout(timeout);
      resolveStart();
    }
  });
});

const source = `
  import java.util.List;
  public final class SplitProbe {
    public static void main(String[] args) {
      System.out.println(String.join(":", List.of(args)));
    }
  }
`;

try {
  const results = [];
  for (const name of selected) {
    const browserType = browserTypes[name];
    if (!browserType) throw new Error(`Unknown browser: ${name}`);
    const browser = await browserType.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin, { waitUntil: "load" });
      const result = await page.evaluate(
        async ({ probeSource }) => {
          const compilerInitialize =
            await globalThis.traceJVMTest.initializeSplitCompiler();
          const compile = await globalThis.traceJVMTest.compileSplitProgram([
            { path: "SplitProbe.java", content: probeSource },
          ]);
          const runnerInitialize =
            await globalThis.traceJVMTest.initializeSplitRunner();
          const guards =
            await globalThis.traceJVMTest.probeSplitRoleGuards();
          globalThis.traceJVMTest.disposeSplitCompiler();
          const run = await globalThis.traceJVMTest.runSplitProgram(
            "SplitProbe",
            ["compiler", "runner"],
          );
          globalThis.traceJVMTest.disposeSplitRunner();
          const replacementRunnerInitialize =
            await globalThis.traceJVMTest.initializeSplitRunner();
          const replacementRun =
            await globalThis.traceJVMTest.runSplitProgram(
              "SplitProbe",
              ["replacement", "runner"],
            );
          globalThis.traceJVMTest.disposeSplitMeasurement();
          return {
            compilerInitialize,
            compile,
            runnerInitialize,
            run,
            replacementRunnerInitialize,
            replacementRun,
            guards,
          };
        },
        { probeSource: source },
      );

      assert.equal(result.compile.status, "completed", name);
      assert.ok(result.compile.artifactBytes > 0, name);
      assert.equal(result.run.status, "completed", name);
      assert.equal(result.run.stdout, "compiler:runner\n", name);
      assert.equal(result.run.isolation.status, "clean", name);
      assert.equal(result.replacementRun.status, "completed", name);
      assert.equal(result.replacementRun.stdout, "replacement:runner\n", name);
      assert.equal(result.replacementRun.isolation.status, "clean", name);
      assert.equal(
        result.guards.runnerCompile,
        "unsupported-by-runner-api",
        name,
      );
      assert.equal(
        result.guards.compilerRun,
        "unsupported-by-compiler-api",
        name,
      );
      results.push({
        browser: name,
        compilerInitializeMs: result.compilerInitialize.initializeMs,
        compileMs: result.compile.timings.totalMs,
        runnerInitializeMs: result.runnerInitialize.initializeMs,
        runMs: result.run.timings.totalMs,
        replacementRunnerInitializeMs:
          result.replacementRunnerInitialize.initializeMs,
        replacementRunMs: result.replacementRun.timings.totalMs,
        artifactBytes: result.compile.artifactBytes,
      });
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  server.kill("SIGTERM");
}
