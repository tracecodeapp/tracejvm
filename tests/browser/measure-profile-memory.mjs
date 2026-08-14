import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const port = Number(process.env.PORT ?? 8765);
const origin = `http://127.0.0.1:${port}`;
const experimentalHotAot = process.env.EXPERIMENTAL_HOT_AOT === "1";
const selectedProfiles = (process.env.PROFILES ??
  "core,server,spring-server").split(",");
const outputPath = resolve(
  process.argv[2] ?? "reports/runtime-profile-memory.json",
);
const server = spawn(process.execPath, ["tests/browser/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolveStart, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM memory host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM memory host exited with ${code}`));
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
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
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
  import java.util.stream.IntStream;
  public class MemoryProbe {
    public static void main(String[] args) {
      System.out.println(IntStream.rangeClosed(1, 4).map(x -> x * x).sum());
    }
  }
`;
const profiles = {};

try {
  for (const profile of selectedProfiles) {
    const browser = await chromium.launch({ headless: true });
    const cdp = await browser.newBrowserCDPSession();
    const baseline = await snapshot(cdp);
    const page = await browser.newPage();
    await page.goto(
      experimentalHotAot ? `${origin}/?experimentalHotAot=1` : origin,
      { waitUntil: "load" },
    );
    const pageReady = await snapshot(cdp);
    const initialize = await page.evaluate(
      (selectedProfile) =>
        globalThis.traceJVMTest.initializeProfileMeasurement(selectedProfile),
      profile,
    );
    await page.waitForTimeout(250);
    const runtimeReady = await snapshot(cdp);

    let peak = runtimeReady;
    const sampler = setInterval(async () => {
      try {
        const current = await snapshot(cdp);
        if (current.totalBytes > peak.totalBytes) peak = current;
      } catch {
        // A short-lived renderer process may exit between CDP and ps.
      }
    }, 25);
    const result = await page.evaluate(
      ({ probeSource }) =>
        globalThis.traceJVMTest.executeProfileMeasurement(
          [{ path: "MemoryProbe.java", content: probeSource }],
          "MemoryProbe",
        ),
      { probeSource: source },
    );
    clearInterval(sampler);
    await page.waitForTimeout(500);
    const warm = await snapshot(cdp);
    await page.evaluate(() =>
      globalThis.traceJVMTest.disposeProfileMeasurement(),
    );
    await page.waitForTimeout(1_000);
    const afterTermination = await snapshot(cdp);

    profiles[profile] = {
      initialize,
      result: {
        status: result.status,
        totalMs: result.timings.totalMs,
      },
      runtimeIncrementOverPageBytes:
        runtimeReady.totalBytes - pageReady.totalBytes,
      peakIncrementOverPageBytes: peak.totalBytes - pageReady.totalBytes,
      warmIncrementOverPageBytes: warm.totalBytes - pageReady.totalBytes,
      retainedAfterTerminationOverPageBytes:
        afterTermination.totalBytes - pageReady.totalBytes,
      snapshots: { baseline, pageReady, runtimeReady, peak, warm, afterTermination },
    };
    await browser.close();
  }

  const report = {
    schema: "tracejvm.runtime-profile-memory.v1",
    measuredAt: new Date().toISOString(),
    host: "Chromium process RSS reported through CDP plus ps",
    configuredHeapBytes: 64 << 20,
    experiments: {
      hotAot: experimentalHotAot,
    },
    profiles,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  server.kill("SIGTERM");
}
