import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, devices, firefox, webkit } from "playwright";

const port = Number(process.env.PORT ?? 8772);
const origin = `http://127.0.0.1:${port}`;
const iterations = Number(process.env.ITERATIONS ?? 12);
const abortCycles = Number(process.env.ABORT_CYCLES ?? 3);
const requested = new Set(
  (process.env.BROWSERS ??
    "chromium,firefox,webkit,webkit-ipad-emulation").split(","),
);
const engines = {
  chromium: { engine: chromium },
  firefox: { engine: firefox },
  webkit: { engine: webkit },
  "webkit-ipad-emulation": {
    engine: webkit,
    context: devices["iPad Pro 11"],
  },
};
const server = spawn(process.execPath, ["tests/browser/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM lifecycle host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM lifecycle host exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("TraceJVM compatibility host")) {
      clearTimeout(timeout);
      resolve();
    }
  });
});

const source = `
  public final class LifecycleProbe {
    private static int executionCount;
    public static void main(String[] args) {
      String leaked = System.getProperty("tracejvm.lifecycle", "missing");
      System.out.println((++executionCount) + ":" + leaked + ":" + args[0]);
      System.setProperty("tracejvm.lifecycle", "leaked");
    }
  }
`;
const reports = [];

try {
  for (const [engineName, configuration] of Object.entries(engines)) {
    if (!requested.has(engineName)) continue;
    process.stderr.write(`[lifecycle] starting ${engineName}\n`);
    const startedAt = performance.now();
    const browser = await configuration.engine.launch({ headless: true });
    const page = await browser.newPage(configuration.context);
    try {
      await page.goto(origin, { waitUntil: "load" });
      await page.waitForFunction(() => "traceJVMTest" in globalThis);
      const repeated = await page.evaluate(
        async ({ probeSource, count }) => {
          const results = [];
          for (let index = 0; index < count; index += 1) {
            const result = await globalThis.traceJVMTest.executeTimed(
              [{ path: "LifecycleProbe.java", content: probeSource }],
              "LifecycleProbe",
              [String(index)],
              60_000,
            );
            results.push({
              status: result.status,
              exitCode: result.exitCode,
              stdout: result.stdout,
              isolation: result.isolation,
              retirementRecommended: result.retirementRecommended,
              totalMs: result.timings.totalMs,
            });
          }
          return results;
        },
        { probeSource: source, count: iterations },
      );

      assert.equal(repeated.length, iterations);
      for (let index = 0; index < repeated.length; index += 1) {
        const result = repeated[index];
        assert.equal(result.status, "completed", `${engineName} iteration ${index}`);
        assert.equal(result.exitCode, 0, `${engineName} iteration ${index}`);
        assert.equal(
          result.stdout,
          `1:missing:${index}\n`,
          `${engineName} iteration ${index} leaked application state`,
        );
        assert.equal(result.isolation.status, "clean");
        assert.equal(
          result.retirementRecommended,
          (index + 1) % 8 === 0,
          `${engineName} iteration ${index} retirement boundary`,
        );
      }

      const aborts = [];
      for (let cycle = 0; cycle < abortCycles; cycle += 1) {
        const result = await page.evaluate(() =>
          globalThis.traceJVMTest.abortAndRecover()
        );
        assert.equal(result.aborted, true, `${engineName} abort cycle ${cycle}`);
        assert.equal(result.recovery.status, "completed");
        assert.equal(result.recovery.stdout, "recovered\n");
        assert.equal(result.recovery.isolation.status, "clean");
        aborts.push({
          aborted: result.aborted,
          recoveryStatus: result.recovery.status,
          recoveryMs: result.recovery.timings.totalMs,
        });
      }

      reports.push({
        engine: engineName,
        success: true,
        iterations,
        retirementBoundaries: repeated
          .map((result, index) => result.retirementRecommended ? index + 1 : null)
          .filter(Boolean),
        aborts,
        wallMs: performance.now() - startedAt,
      });
    } catch (error) {
      reports.push({
        engine: engineName,
        success: false,
        fatal: error instanceof Error ? error.stack : String(error),
        wallMs: performance.now() - startedAt,
      });
    } finally {
      await browser.close();
      process.stderr.write(
        `[lifecycle] finished ${engineName} in ` +
          `${Math.round(performance.now() - startedAt)}ms\n`,
      );
    }
  }
} finally {
  server.kill("SIGTERM");
}

mkdirSync("reports", { recursive: true });
writeFileSync(
  join("reports", "lifecycle-stress.json"),
  `${JSON.stringify({
    schema: "tracejvm.lifecycle-stress.v1",
    measuredAt: new Date().toISOString(),
    iterations,
    abortCycles,
    reports,
  }, null, 2)}\n`,
);
console.log(JSON.stringify(reports, null, 2));
if (reports.some(({ success }) => !success)) process.exitCode = 1;
