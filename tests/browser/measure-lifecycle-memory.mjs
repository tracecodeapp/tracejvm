import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.PORT ?? 8773);
const origin = `http://127.0.0.1:${port}`;
const cycles = Number(process.env.CYCLES ?? 10);
const plateauBudgetBytes = Number(
  process.env.PLATEAU_BUDGET_BYTES ?? 32 << 20,
);
const outputPath = resolve(
  process.argv[2] ?? "reports/lifecycle-memory.json",
);
const server = spawn(process.execPath, ["tests/browser/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolveStart, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM lifecycle memory host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM lifecycle memory host exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("TraceJVM compatibility host")) {
      clearTimeout(timeout);
      resolveStart();
    }
  });
});

async function snapshot(cdp) {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  const pids = [...new Set(processInfo.map(({ id }) => id).filter((id) => id > 0))];
  if (pids.length === 0) return { totalBytes: 0, byType: {} };
  const output = execFileSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const rss = new Map(
    output.trim().split("\n").filter(Boolean).map((line) => {
      const [pid, kib] = line.trim().split(/\s+/).map(Number);
      return [pid, kib * 1024];
    }),
  );
  const byType = {};
  let totalBytes = 0;
  for (const process of processInfo) {
    const bytes = rss.get(process.id) ?? 0;
    totalBytes += bytes;
    byType[process.type] = (byType[process.type] ?? 0) + bytes;
  }
  return { totalBytes, byType };
}

const source = `
  import java.util.ArrayList;
  public final class LifecycleMemoryProbe {
    public static void main(String[] args) {
      ArrayList<byte[]> allocations = new ArrayList<>();
      for (int index = 0; index < 32; index += 1) {
        allocations.add(new byte[64 * 1024]);
      }
      System.out.println(allocations.size());
    }
  }
`;

try {
  const browser = await chromium.launch({ headless: true });
  const cdp = await browser.newBrowserCDPSession();
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: "load" });
  const pageReady = await snapshot(cdp);
  const measurements = [];

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const initialize = await page.evaluate(() =>
      globalThis.traceJVMTest.initializeProfileMeasurement("core")
    );
    const runtimeReady = await snapshot(cdp);
    const result = await page.evaluate(
      (probeSource) =>
        globalThis.traceJVMTest.executeProfileMeasurement(
          [{ path: "LifecycleMemoryProbe.java", content: probeSource }],
          "LifecycleMemoryProbe",
        ),
      source,
    );
    assert.equal(result.status, "completed", `cycle ${cycle + 1}`);
    assert.equal(result.stdout, "32\n", `cycle ${cycle + 1}`);
    await page.evaluate(() =>
      globalThis.traceJVMTest.disposeProfileMeasurement()
    );
    await page.waitForTimeout(1_000);
    const afterTermination = await snapshot(cdp);
    measurements.push({
      cycle: cycle + 1,
      initialize,
      result: {
        status: result.status,
        stdout: result.stdout,
        totalMs: result.timings.totalMs,
      },
      runtimeIncrementOverPageBytes:
        runtimeReady.totalBytes - pageReady.totalBytes,
      retainedAfterTerminationOverPageBytes:
        afterTermination.totalBytes - pageReady.totalBytes,
      snapshots: { runtimeReady, afterTermination },
    });
  }

  const firstRetention =
    measurements[0]?.retainedAfterTerminationOverPageBytes ?? 0;
  const finalRetention =
    measurements.at(-1)?.retainedAfterTerminationOverPageBytes ?? 0;
  const tail = measurements.slice(-3).map(
    ({ retainedAfterTerminationOverPageBytes }) =>
      retainedAfterTerminationOverPageBytes,
  );
  const tailRangeBytes = tail.length > 0
    ? Math.max(...tail) - Math.min(...tail)
    : 0;
  const plateauObserved = tail.length === 3 &&
    tailRangeBytes <= plateauBudgetBytes;
  const report = {
    schema: "tracejvm.lifecycle-memory.v1",
    measuredAt: new Date().toISOString(),
    host: "Chromium process RSS reported through CDP plus ps",
    configuredHeapBytes: 64 << 20,
    cycles,
    pageReady,
    retentionGrowthAfterFirstCycleBytes: finalRetention - firstRetention,
    plateauBudgetBytes,
    tailRangeBytes,
    plateauObserved,
    measurements,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!plateauObserved) process.exitCode = 1;
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
