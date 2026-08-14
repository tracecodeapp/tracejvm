import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chromium,
  firefox,
  webkit,
} from "playwright";

const port = Number(process.env.PORT ?? 8778);
const origin = `http://127.0.0.1:${port}`;
const selected = (process.env.BROWSERS ?? "chromium,firefox,webkit").split(",");
const browserTypes = { chromium, firefox, webkit };
const server = spawn(process.execPath, ["tests/browser/serve.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolveStart, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM TeaVM javac test host did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM TeaVM javac test host exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (chunk.toString().includes("TraceJVM compatibility host")) {
      clearTimeout(timeout);
      resolveStart();
    }
  });
});

const source = `
  sealed interface Input permits NumberInput, TextInput {}
  record NumberInput(int value) implements Input {}
  record TextInput(String value) implements Input {}

  public final class Jdk23BackendProbe {
    static int size(Input input) {
      return switch (input) {
        case NumberInput number -> number.value();
        case TextInput text -> text.value().length();
      };
    }

    public static void main(String[] args) {
      System.out.println(size(new NumberInput(23)) + size(new TextInput("java")));
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
          const base = "/.cache/teavm-javac/artifacts";
          const { load } = await import(`${base}/compiler.wasm-runtime.js`);
          const loadStartedAt = performance.now();
          const [teavm, sdkResponse] = await Promise.all([
            load(`${base}/compiler.wasm`, {
              stackDeobfuscator: {
                enabled: true,
                path: `${base}/compiler.wasm-deobfuscator.wasm`,
                infoLocation: "external",
                externalInfoPath: `${base}/compiler.wasm.teadbg`,
              },
            }),
            fetch(`${base}/compile-classlib-teavm.bin`),
          ]);
          const loadMs = performance.now() - loadStartedAt;
          const compiler = teavm.exports.createCompiler();
          compiler.setSdk(
            new Int8Array(await sdkResponse.arrayBuffer()),
          );
          const diagnostics = [];
          compiler.onDiagnostic((diagnostic) => {
            diagnostics.push({
              severity: diagnostic.severity,
              message: diagnostic.message,
              lineNumber: diagnostic.lineNumber,
              columnNumber: diagnostic.columnNumber,
            });
          });
          compiler.addSourceFile("Jdk23BackendProbe.java", probeSource);
          const compileStartedAt = performance.now();
          const ok = compiler.compile();
          const compileMs = performance.now() - compileStartedAt;
          const outputNames = Array.from(compiler.listOutputFiles());
          const files = outputNames.map((path) => ({
            path,
            content: new Uint8Array(compiler.getOutputFile(path)),
          }));
          const headers = files.map(({ path, content }) => ({
            path,
            magic: Array.from(content.slice(0, 4)),
            minor: (content[4] << 8) | content[5],
            major: (content[6] << 8) | content[7],
          }));
          const run = ok
            ? await globalThis.traceJVMTest.runInFreshRunner(
                { files },
                "Jdk23BackendProbe",
              )
            : undefined;
          return {
            ok,
            diagnostics,
            loadMs,
            compileMs,
            outputBytes: files.reduce(
              (total, file) => total + file.content.byteLength,
              0,
            ),
            headers,
            run,
          };
        },
        { probeSource: source },
      );

      assert.equal(result.ok, true, `${name}: compiler status`);
      assert.deepEqual(result.diagnostics, [], `${name}: diagnostics`);
      assert.ok(result.outputBytes > 0, `${name}: output bytes`);
      assert.ok(result.headers.length >= 4, `${name}: output class count`);
      for (const header of result.headers) {
        assert.deepEqual(
          header.magic,
          [0xca, 0xfe, 0xba, 0xbe],
          `${name}: ${header.path} magic`,
        );
        assert.equal(header.minor, 0, `${name}: ${header.path} minor`);
        assert.equal(header.major, 67, `${name}: ${header.path} major`);
      }
      assert.equal(result.run.status, "completed", `${name}: run status`);
      assert.equal(result.run.stdout, "27\n", `${name}: stdout`);
      assert.equal(result.run.stderr, "", `${name}: stderr`);
      assert.equal(
        result.run.isolation.status,
        "clean",
        `${name}: isolation`,
      );
      results.push({
        browser: name,
        loadMs: result.loadMs,
        compileMs: result.compileMs,
        outputBytes: result.outputBytes,
        outputClasses: result.headers.length,
        runMs: result.run.timings.totalMs,
      });
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  server.kill("SIGTERM");
}
