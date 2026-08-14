import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(root, "compatibility/openjdk/catalog.json"), "utf8"),
);
const runtimeManifest = JSON.parse(
  readFileSync(join(root, "runtime/manifest.json"), "utf8"),
);
const checkout = join(root, ".cache/openjdk-jdk23u/test/jdk");
const seed = process.env.CAMPAIGN_SEED ?? "tracejvm-openjdk-23-v2";
const limit = Number(process.env.CAMPAIGN_LIMIT ?? 50);
const pathFilter = process.env.CAMPAIGN_PATH;
const caseTimeoutMs = Number(process.env.CAMPAIGN_TIMEOUT_MS ?? 20_000);
const port = Number(process.env.CAMPAIGN_PORT ?? 8766);
const systemProperties = {
  "file.encoding": "UTF-8",
  "user.country": "US",
  "user.language": "en",
  "user.timezone": "UTC",
};

const FAILURE_KINDS = [
  "tracejvm-semantic-defect",
  "missing-runtime-module",
  "missing-native",
  "unsupported-browser-capability",
  "test-infrastructure",
  "timeout",
];

function score(key) {
  return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function splitArguments(text) {
  if (!text) return [];
  const values = [];
  const matcher = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/gu;
  for (const match of text.matchAll(matcher)) {
    values.push(
      match[1] !== undefined
        ? match[1].replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\")
        : match[2] ?? match[3],
    );
  }
  return values;
}

function invocations(entry, source) {
  const packageName = source.match(/^\s*package\s+([\w.]+)\s*;/mu)?.[1];
  const mainRuns = entry.runs
    .map((run) => run.match(/(?:^| )main(?:\/\S+)?\s+(\S+)(?:\s+(.*))?$/u))
    .filter(Boolean);
  if (mainRuns.length === 0) {
    const simpleName = basename(entry.path, ".java");
    return [{
      mainClass: packageName ? `${packageName}.${simpleName}` : simpleName,
      args: [],
    }];
  }
  return mainRuns.map((mainRun) => {
    const className = mainRun[1];
    return {
      mainClass: className.includes(".") || !packageName
        ? className
        : `${packageName}.${className}`,
      args: splitArguments(mainRun[2] ?? ""),
    };
  });
}

function findReferenceJavaHome() {
  const candidates = [
    process.env.OPENJDK_23_HOME,
    join(root, ".cache/temurin-23-mac/jdk-23.0.2+7/Contents/Home"),
  ].filter(Boolean);
  for (const home of candidates) {
    const version = spawnSync(join(home, "bin/java"), ["-version"], {
      encoding: "utf8",
    });
    const detail = `${version.stdout ?? ""}${version.stderr ?? ""}`;
    if (
      version.status === 0 &&
      detail.includes(`version "23.0.2"`) &&
      detail.includes("23.0.2+7")
    ) {
      return home;
    }
  }
  throw new Error(
    "Pinned native OpenJDK 23.0.2+7 was not found. Set OPENJDK_23_HOME.",
  );
}

function command(binary, args, options) {
  const result = spawnSync(binary, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
    error: result.error
      ? result.error.stack ?? String(result.error)
      : undefined,
  };
}

function classArtifacts(directory) {
  const output = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".class")) {
        const content = readFileSync(path);
        output.push({
          path: relative(directory, path),
          bytes: statSync(path).size,
          sha256: sha256(content),
        });
      }
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function nativeOracle(javaHome, candidate) {
  const directory = mkdtempSync(join(tmpdir(), "tracejvm-openjdk-oracle-"));
  const classes = join(directory, "classes");
  mkdirSync(classes);
  const sourceName = basename(candidate.path);
  writeFileSync(join(directory, sourceName), candidate.source);
  try {
    const compile = command(
      join(javaHome, "bin/javac"),
      ["-proc:none", "-g", "-d", classes, sourceName],
      { cwd: directory, timeoutMs: caseTimeoutMs },
    );
    if (compile.timedOut) {
      return {
        usable: false,
        failureKind: "timeout",
        reason: "native-oracle-compile-timeout",
        compile,
      };
    }
    if (compile.status !== 0) {
      const detail = `${compile.stdout}\n${compile.stderr}`;
      return {
        usable: false,
        failureKind: "test-infrastructure",
        reason: /preview API (?:and )?is disabled by default/u.test(detail)
          ? "requires-preview-compiler-mode"
          : "native-oracle-compile-failed",
        compile,
      };
    }

    const propertyArgs = Object.entries(systemProperties)
      .map(([key, value]) => `-D${key}=${value}`);
    const run = command(
      join(javaHome, "bin/java"),
      [
        ...propertyArgs,
        "-cp",
        classes,
        candidate.mainClass,
        ...candidate.args,
      ],
      { cwd: directory, timeoutMs: caseTimeoutMs },
    );
    if (run.timedOut) {
      return {
        usable: false,
        failureKind: "timeout",
        reason: "native-oracle-run-timeout",
        compile,
        run,
      };
    }
    if (run.status !== 0) {
      return {
        usable: false,
        failureKind: "test-infrastructure",
        reason: "native-oracle-test-failed",
        compile,
        run,
      };
    }
    return {
      usable: true,
      compile,
      run,
      artifacts: classArtifacts(classes),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function normalizeOutput(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n");
}

function sameArtifacts(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparisonMode(candidate) {
  if (
    /(?:^|\/)[^/]*(?:Micro)?Benchmark\.java$/u.test(candidate.path) ||
    /@summary\s+(?:benchmark|stress)\b/iu.test(candidate.source)
  ) {
    return "self-verifying-performance";
  }
  if (/System\.getProperties\(\)/u.test(candidate.source)) {
    return "self-verifying-environment";
  }
  return "observable-output";
}

function classifyBrowserResult(result, error, oracle, mode) {
  const detail = [
    result?.compile?.stderr,
    result?.run?.stderr,
    error,
  ].filter(Boolean).join("\n");
  if (
    /AbortError: TraceJVM operation was aborted|TimeoutError|timed out/iu
      .test(detail)
  ) {
    return { kind: "timeout", reason: "browser-execution-timeout" };
  }
  if (
    result?.compile?.status === "compile-error" &&
    /package (?:java|javax)\.[\w.]+ does not exist|module [\w.]+ not found/u
      .test(detail)
  ) {
    return {
      kind: "missing-runtime-module",
      reason: "required-openjdk-module-not-in-core-profile",
    };
  }
  if (/java\.lang\.UnsatisfiedLinkError/u.test(detail)) {
    return { kind: "missing-native", reason: "openjdk-native-not-implemented" };
  }
  if (
    /SharedArrayBuffer|cross-origin isolat|not supported in this browser/iu
      .test(detail)
  ) {
    return {
      kind: "unsupported-browser-capability",
      reason: "required-browser-capability-unavailable",
    };
  }
  if (!result?.run || result.compile?.status !== "completed") {
    return {
      kind: "tracejvm-semantic-defect",
      reason: "tracejvm-compile-differs-from-native-openjdk",
    };
  }
  if (result.run.status !== "completed" || result.run.exitCode !== 0) {
    return {
      kind: "tracejvm-semantic-defect",
      reason: "tracejvm-runtime-differs-from-native-openjdk",
    };
  }
  if (!sameArtifacts(result.artifacts, oracle.artifacts)) {
    return {
      kind: "tracejvm-semantic-defect",
      reason: "javac-classfile-mismatch",
    };
  }
  if (
    normalizeOutput(result.run.stdout).includes("Incomplete") &&
    !normalizeOutput(oracle.run.stdout).includes("Incomplete")
  ) {
    return {
      kind: "timeout",
      reason: "test-internal-deadline-exhausted",
    };
  }
  if (
    mode === "observable-output" &&
    normalizeOutput(result.run.stdout) !== normalizeOutput(oracle.run.stdout) ||
    mode === "observable-output" &&
    normalizeOutput(result.run.stderr) !== normalizeOutput(oracle.run.stderr)
  ) {
    return {
      kind: "tracejvm-semantic-defect",
      reason: "observable-output-mismatch",
    };
  }
  if (error) {
    return {
      kind: "test-infrastructure",
      reason: "browser-campaign-evaluation-failed",
    };
  }
  return undefined;
}

const expandedCandidates = catalog.entries
  .filter(
    ({ classification, path }) =>
      classification === "direct-main-candidate" &&
      (pathFilter === undefined || path === pathFilter),
  )
  .flatMap((entry) => {
    const source = readFileSync(join(checkout, entry.path), "utf8");
    return invocations(entry, source).map((invocation, invocationIndex) => ({
      ...entry,
      ...invocation,
      source,
      invocationIndex,
      key: `${entry.path}#${invocationIndex}`,
    }));
  })
  .map((entry) => ({ ...entry, score: score(entry.key) }))
  .sort((left, right) => left.score.localeCompare(right.score))
  .slice(0, limit);

const javaHome = findReferenceJavaHome();
const nativeCases = expandedCandidates.map((candidate, index) => {
  process.stderr.write(
    `[openjdk-campaign] oracle ${index + 1}/${expandedCandidates.length} ${candidate.key}\n`,
  );
  return {
    candidate,
    oracle: nativeOracle(javaHome, candidate),
  };
});
const results = nativeCases
  .filter(({ oracle }) => !oracle.usable)
  .map(({ candidate, oracle }) => ({
    key: candidate.key,
    path: candidate.path,
    mainClass: candidate.mainClass,
    args: candidate.args,
    passed: false,
    failureKind: oracle.failureKind,
    reason: oracle.reason,
    oracle,
  }));

const runnableCases = nativeCases.filter(({ oracle }) => oracle.usable);
if (runnableCases.length > 0) {
  const server = spawn(
    process.execPath,
    [join(root, "tests/browser/serve.mjs")],
    {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("TraceJVM campaign server did not start")),
      10_000,
    );
    server.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`TraceJVM campaign server exited with ${code}`));
    });
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("compatibility host")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "load" });
    await page.waitForFunction(() => "traceJVMTest" in globalThis);
    await page.evaluate(() => globalThis.traceJVMTest.initialize());
    for (const [index, { candidate, oracle }] of runnableCases.entries()) {
      process.stderr.write(
        `[openjdk-campaign] browser ${index + 1}/${runnableCases.length} ${candidate.key}\n`,
      );
      const startedAt = performance.now();
      const mode = comparisonMode(candidate);
      try {
        const result = await page.evaluate(
          ({
            filename,
            source,
            mainClass,
            args,
            timeoutMs,
            systemProperties,
          }) =>
            globalThis.traceJVMTest.compileAndRunTimed(
              [{ path: filename, content: source }],
              mainClass,
              args,
              timeoutMs,
              systemProperties,
            ),
          {
            filename: basename(candidate.path),
            source: candidate.source,
            mainClass: candidate.mainClass,
            args: candidate.args,
            timeoutMs: caseTimeoutMs,
            systemProperties,
          },
        );
        const failure = classifyBrowserResult(result, undefined, oracle, mode);
        results.push({
          key: candidate.key,
          path: candidate.path,
          mainClass: candidate.mainClass,
          args: candidate.args,
          passed: failure === undefined,
          failureKind: failure?.kind,
          reason: failure?.reason,
          comparison: {
            mode,
            classfilesEqual: sameArtifacts(result.artifacts, oracle.artifacts),
            stdoutEqual: mode === "observable-output"
              ? (
              normalizeOutput(result.run?.stdout) ===
              normalizeOutput(oracle.run.stdout)
              )
              : undefined,
            stderrEqual: mode === "observable-output"
              ? (
              normalizeOutput(result.run?.stderr) ===
              normalizeOutput(oracle.run.stderr)
              )
              : undefined,
          },
          oracle,
          result,
          wallMs: performance.now() - startedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.stack : String(error);
        const failure = classifyBrowserResult(undefined, message, oracle, mode);
        results.push({
          key: candidate.key,
          path: candidate.path,
          mainClass: candidate.mainClass,
          args: candidate.args,
          passed: false,
          failureKind: failure?.kind ?? "test-infrastructure",
          reason: failure?.reason ?? "browser-campaign-evaluation-failed",
          oracle,
          error: message,
          wallMs: performance.now() - startedAt,
        });
      }
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

results.sort((left, right) => left.key.localeCompare(right.key));
for (const result of results) {
  if (!result.passed && !FAILURE_KINDS.includes(result.failureKind)) {
    throw new Error(
      `Campaign result ${result.key} lacks a valid failure classification`,
    );
  }
}

mkdirSync(join(root, "reports"), { recursive: true });
const report = {
  schema: "tracejvm.openjdk-campaign.v2",
  measuredAt: new Date().toISOString(),
  upstream: catalog.generatedFrom,
  runtime: {
    javaVersion: runtimeManifest.javaVersion,
    profile: "core",
  },
  oracle: {
    distribution: runtimeManifest.distribution,
    javaHome,
    javaVersion: runtimeManifest.javaVersion,
  },
  browsers: ["chromium"],
  seed,
  pathFilter,
  limit,
  timeoutMs: caseTimeoutMs,
  selected: expandedCandidates.length,
  oracleRunnable: runnableCases.length,
  passed: results.filter(({ passed }) => passed).length,
  failed: results.filter(({ passed }) => !passed).length,
  failureKinds: Object.fromEntries(
    FAILURE_KINDS.map((kind) => [
      kind,
      results.filter(({ failureKind }) => failureKind === kind).length,
    ]),
  ),
  failureReasons: Object.fromEntries(
    Array.from(
      results
        .filter(({ reason }) => reason)
        .reduce((counts, { reason }) => {
          counts.set(reason, (counts.get(reason) ?? 0) + 1);
          return counts;
        }, new Map()),
    ).sort(([left], [right]) => left.localeCompare(right)),
  ),
  results,
};
writeFileSync(
  join(root, "reports/openjdk-campaign.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify({
  schema: report.schema,
  seed,
  selected: report.selected,
  oracleRunnable: report.oracleRunnable,
  passed: report.passed,
  failed: report.failed,
  failureKinds: report.failureKinds,
  failureReasons: report.failureReasons,
}, null, 2));
if (process.env.CAMPAIGN_ENFORCE === "1" && report.failed > 0) {
  process.exitCode = 1;
}
