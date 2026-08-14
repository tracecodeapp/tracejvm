import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(root, "compatibility/openjdk/manifest.json"), "utf8"),
);
const requested = new Set(
  (process.env.BROWSERS ?? "chromium,firefox,webkit,webkit-ipad-emulation").split(","),
);
const requestedCases = new Set(
  (process.env.CASES ?? "").split(",").map((id) => id.trim()).filter(Boolean),
);
const experimentalHotAot = process.env.EXPERIMENTAL_HOT_AOT === "1";
const port = Number(process.env.PORT ?? 8765);
const fatalProcessFileConsoleMessage = (message) =>
  message.includes("Fatal error in FS.readFile") ||
  message.startsWith("Aborted(");
const engines = {
  chromium: { engine: chromium },
  firefox: { engine: firefox },
  webkit: { engine: webkit },
  "webkit-ipad-emulation": {
    engine: webkit,
    context: devices["iPad Pro 11"],
  },
};

const smoke = [
  {
    id: "hard-abort-worker-recovery",
    mode: "abort-recover",
    validate: ({ aborted, recovery }) =>
      aborted === true &&
      recovery.status === "completed" &&
      recovery.stdout === "recovered\n",
  },
  {
    id: "compile-run-separation",
    mode: "compile-run",
    sources: [{
      path: "Separated.java",
      content: `public class Separated {
        static int executions;
        public static void main(String[] args) {
          System.out.println("compiled:" + args[0] + ":" + (++executions));
        }
      }`,
    }],
    mainClass: "Separated",
    args: ["once"],
    validate: ({ compile, firstRun, secondRun }) =>
      compile.status === "completed" &&
      Array.isArray(compile.program?.files) &&
      compile.program.files.some(({ path }) => path === "Separated.class") &&
      firstRun.status === "completed" &&
      firstRun.stdout === "compiled:once:1\n" &&
      secondRun.status === "completed" &&
      secondRun.stdout === "compiled:twice:1\n",
  },
  {
    id: "main-arguments",
    sources: [{
      path: "Entry.java",
      content: `public class Entry {
        public static void main(String[] args) {
          System.out.println(String.join("|", args));
        }
      }`,
    }],
    mainClass: "Entry",
    args: ["workspace value", "こんにちは", ""],
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "workspace value|こんにちは|\n" &&
      result.streamedStdout === result.stdout,
  },
  {
    id: "packaged-multiple-top-level-classes",
    sources: [{
      path: "tracecode/user/Exports.java",
      content: `package tracecode.user;
        class Solution {
          static int answer() { return 42; }
        }
        public class Exports {
          public static void main(String[] args) {
            System.out.println(Solution.answer());
          }
        }`,
    }],
    mainClass: "tracecode.user.Exports",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "42\n",
  },
  {
    id: "java-io-recursive-directory-creation",
    sources: [{
      path: "DirectoryEntry.java",
      content: `import java.io.File;
        public class DirectoryEntry {
          public static void main(String[] args) {
            File directory = new File("/workspace/java-io/nested");
            System.out.println(directory.mkdirs());
            System.out.println(directory.isDirectory());
          }
        }`,
    }],
    mainClass: "DirectoryEntry",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "true\ntrue\n",
  },
  {
    id: "java-nio-recursive-directory-creation",
    sources: [{
      path: "NioDirectoryEntry.java",
      content: `import java.nio.file.Files;
        import java.nio.file.Path;
        public class NioDirectoryEntry {
          public static void main(String[] args) throws Exception {
            Path directory = Path.of("/workspace/java-nio/nested");
            Files.createDirectories(directory);
            System.out.println(Files.isDirectory(directory));
          }
        }`,
    }],
    mainClass: "NioDirectoryEntry",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "true\n",
  },
  {
    id: "member-class-reflection",
    sources: [{
      path: "ReflectionEntry.java",
      content: `public class ReflectionEntry {
        static class Member {}
        public static void main(String[] args) {
          System.out.println(Member.class.getDeclaringClass().getName());
          System.out.println(Member.class.getCanonicalName());
        }
      }`,
    }],
    mainClass: "ReflectionEntry",
    args: [],
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "ReflectionEntry\nReflectionEntry.Member\n",
  },
  {
    id: "reflective-array-set",
    sources: [{
      path: "ReflectiveArraySet.java",
      content: `import java.lang.reflect.Array;
        import java.util.Arrays;
        public class ReflectiveArraySet {
          public static void main(String[] args) {
            int[] ints = new int[2];
            Array.set(ints, 0, Integer.valueOf(7));
            Array.set(ints, 1, Byte.valueOf((byte) 3));

            long[] longs = new long[1];
            Array.set(longs, 0, Integer.valueOf(11));

            double[] doubles = new double[1];
            Array.set(doubles, 0, Float.valueOf(2.5f));

            String[] names = new String[1];
            Array.set(names, 0, "tracejvm");

            System.out.println(Arrays.toString(ints));
            System.out.println(Arrays.toString(longs));
            System.out.println(Arrays.toString(doubles));
            System.out.println(Arrays.toString(names));

            try {
              Array.set(ints, 0, Long.valueOf(1));
              System.out.println("missing primitive mismatch");
            } catch (IllegalArgumentException expected) {
              System.out.println("primitive mismatch");
            }
            try {
              Array.set(names, 0, Integer.valueOf(1));
              System.out.println("missing reference mismatch");
            } catch (IllegalArgumentException expected) {
              System.out.println("reference mismatch");
            }
          }
        }`,
    }],
    mainClass: "ReflectiveArraySet",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout ===
        "[7, 3]\n[11]\n[2.5]\n[tracejvm]\nprimitive mismatch\nreference mismatch\n",
  },
  {
    id: "compiler-diagnostic",
    sources: [{
      path: "Broken.java",
      content: `public class Broken {
        public static void main(String[] args) { int answer = ; }
      }`,
    }],
    mainClass: "Broken",
    validate: (result) =>
      result.status === "compile-error" &&
      result.exitCode === 1 &&
      result.stderr.includes("illegal start of expression"),
  },
  {
    id: "application-static-isolation-first",
    sources: [{
      path: "Counter.java",
      content: `public class Counter {
        static int value;
        public static void main(String[] args) { System.out.println(++value); }
      }`,
    }],
    mainClass: "Counter",
    validate: (result) => result.status === "completed" && result.stdout === "1\n",
  },
  {
    id: "application-static-isolation-second",
    sources: [{
      path: "Counter.java",
      content: `public class Counter {
        static int value;
        public static void main(String[] args) { System.out.println(++value); }
      }`,
    }],
    mainClass: "Counter",
    validate: (result) => result.status === "completed" && result.stdout === "1\n",
  },
  {
    id: "system-property-process-scope",
    sources: [{
      path: "PropertyEntry.java",
      content: `public class PropertyEntry {
        public static void main(String[] args) {
          System.out.println(System.getProperty("tracejvm.request", "missing"));
          System.setProperty("tracejvm.leak", "mutated");
        }
      }`,
    }],
    mainClass: "PropertyEntry",
    systemProperties: { "tracejvm.request": "configured" },
    validate: (result) =>
      result.status === "completed" && result.stdout === "configured\n",
  },
  {
    id: "system-property-isolation",
    sources: [{
      path: "PropertyIsolation.java",
      content: `public class PropertyIsolation {
        public static void main(String[] args) {
          System.out.println(System.getProperty("tracejvm.request", "missing"));
          System.out.println(System.getProperty("tracejvm.leak", "missing"));
        }
      }`,
    }],
    mainClass: "PropertyIsolation",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "missing\nmissing\n",
  },
  {
    id: "process-files-seed",
    sources: [{
      path: "ProcessFileSeed.java",
      content: `import java.nio.file.Files;
        import java.nio.file.Path;
        public class ProcessFileSeed {
          public static void main(String[] args) throws Exception {
            Files.createDirectories(Path.of("/workspace"));
            Files.writeString(Path.of("/workspace/preserved-input.txt"), "baseline");
          }
        }`,
    }],
    mainClass: "ProcessFileSeed",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "",
  },
  {
    id: "process-files-visible",
    sources: [{
      path: "ProcessFileVisible.java",
      content: `import java.nio.file.Files;
        import java.nio.file.Path;
        public class ProcessFileVisible {
          public static void main(String[] args) throws Exception {
            System.out.println(Files.readString(Path.of("/workspace/process-input.txt")));
            System.out.println(Files.readString(Path.of("/workspace/preserved-input.txt")));
          }
        }`,
    }],
    mainClass: "ProcessFileVisible",
    processFiles: [{
      path: "/workspace/process-input.txt",
      content: "request scoped",
    }, {
      path: "/workspace/preserved-input.txt",
      content: "overridden",
    }],
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "request scoped\noverridden\n",
  },
  {
    id: "process-files-cleaned",
    sources: [{
      path: "ProcessFileCleaned.java",
      content: `import java.nio.file.Files;
        import java.nio.file.Path;
        public class ProcessFileCleaned {
          public static void main(String[] args) throws Exception {
            System.out.println(Files.readString(Path.of("/workspace/preserved-input.txt")));
            System.out.println(Files.exists(Path.of("/workspace/process-input.txt")));
          }
        }`,
    }],
    mainClass: "ProcessFileCleaned",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "baseline\nfalse\n",
  },
  {
    id: "execution-scope-process-state-mutation",
    sources: [{
      path: "ProcessStateMutation.java",
      content: `import java.io.ByteArrayInputStream;
        import java.io.ByteArrayOutputStream;
        import java.io.PrintStream;
        import java.util.Locale;
        import java.util.Properties;
        import java.util.TimeZone;
        public class ProcessStateMutation {
          private static final ThreadLocal<String> local = new ThreadLocal<>();
          public static void main(String[] args) throws Exception {
            System.out.println("before-mutation");
            local.set("application-value");
            System.in.close();
            System.out.close();
            System.err.close();
            System.setProperties(new Properties());
            System.setIn(new ByteArrayInputStream(new byte[] { 1 }));
            System.setOut(new PrintStream(new ByteArrayOutputStream()));
            System.setErr(new PrintStream(new ByteArrayOutputStream()));
            Locale.setDefault(Locale.JAPAN);
            TimeZone.setDefault(TimeZone.getTimeZone("GMT+09:00"));
            Thread current = Thread.currentThread();
            current.setName("scope-mutated");
            current.setPriority(Thread.MAX_PRIORITY);
            current.setUncaughtExceptionHandler((thread, error) -> {});
            Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {});
            current.interrupt();
          }
        }`,
    }],
    mainClass: "ProcessStateMutation",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "before-mutation\n" &&
      result.isolation?.status === "clean" &&
      [
        "system-properties",
        "system-streams",
        "default-locale",
        "default-time-zone",
        "thread-context-class-loader",
        "thread-uncaught-handlers",
        "thread-metadata",
        "thread-locals",
      ].every((capability) =>
        result.isolation.restored.includes(capability)
      ),
  },
  {
    id: "thread-local-and-reference-semantics",
    sources: [{
      path: "ThreadLocalAndReferenceSemantics.java",
      content: `import java.lang.ref.WeakReference;
        public class ThreadLocalAndReferenceSemantics {
          public static void main(String[] args) {
            ThreadLocal<String> local = new ThreadLocal<>();
            InheritableThreadLocal<Integer> inherited = new InheritableThreadLocal<>();
            local.set("present");
            inherited.set(42);

            Object referent = new Object();
            WeakReference<Object> weak = new WeakReference<>(referent);
            System.out.println(local.get());
            System.out.println(inherited.get());
            System.out.println(weak.refersTo(referent));
            weak.clear();
            System.out.println(weak.get() == null);
            local.remove();
            inherited.remove();
            System.out.println(local.get() == null);
            System.out.println(inherited.get() == null);
          }
        }`,
    }],
    mainClass: "ThreadLocalAndReferenceSemantics",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "present\n42\ntrue\ntrue\ntrue\ntrue\n",
  },
  {
    id: "execution-scope-process-state-recovery",
    sources: [{
      path: "ProcessStateRecovery.java",
      content: `public class ProcessStateRecovery {
        public static void main(String[] args) {
          System.out.println(System.getProperty("java.version"));
          System.out.println(Thread.currentThread().getName());
          System.out.println(Thread.currentThread().isInterrupted());
        }
      }`,
    }],
    mainClass: "ProcessStateRecovery",
    validate: (result) => {
      const lines = result.stdout.trimEnd().split("\n");
      return (
        result.status === "completed" &&
        lines[0]?.startsWith("23") === true &&
        lines[1] === "main" &&
        lines[2] === "false" &&
        result.isolation?.status === "clean"
      );
    },
  },
  {
    id: "execution-scope-thread-taint",
    sources: [{
      path: "ThreadTaint.java",
      content: `public class ThreadTaint {
        public static void main(String[] args) {
          Thread child = new Thread(() -> {
            try {
              Thread.sleep(10_000);
            } catch (InterruptedException expected) {
              // Scope cleanup owns the interrupt.
            }
          }, "application-child");
          child.start();
          System.out.println("spawned");
        }
      }`,
    }],
    mainClass: "ThreadTaint",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "spawned\n" &&
      result.isolation?.status === "tainted" &&
      result.isolation.taintReasons.includes("application-thread-created") &&
      result.isolation.hardBoundaryRecommended === true &&
      result.retirementRecommended === true,
  },
  {
    id: "execution-scope-short-lived-thread-taint",
    sources: [{
      path: "ShortLivedThreadTaint.java",
      content: `public class ShortLivedThreadTaint {
        public static void main(String[] args) throws Exception {
          Thread child = new Thread(() -> {}, "short-lived-application-child");
          child.start();
          child.join();
          System.out.println(child.isAlive());
        }
      }`,
    }],
    mainClass: "ShortLivedThreadTaint",
    validate: (result) =>
      result.status === "completed" &&
      result.stdout === "false\n" &&
      result.isolation?.status === "tainted" &&
      result.isolation.taintReasons.includes("application-thread-created") &&
      result.isolation.hardBoundaryRecommended === true &&
      result.retirementRecommended === true,
  },
  {
    id: "fork-join-runtime",
    sources: [{
      path: "ForkJoinEntry.java",
      content: `import java.util.concurrent.ForkJoinPool;
        import java.util.concurrent.RecursiveTask;
        public class ForkJoinEntry {
          public static void main(String[] args) {
            int value = ForkJoinPool.commonPool().invoke(new RecursiveTask<>() {
              protected Integer compute() { return 42; }
            });
            System.out.println(value);
          }
        }`,
    }],
    mainClass: "ForkJoinEntry",
    validate: (result) =>
      result.status === "completed" && result.stdout === "42\n",
  },
];

const openJdkCases = manifest.tests.map((test) => ({
  id: `openjdk:${test.path}`,
  sources: [{
    path: basename(test.path),
    content: readFileSync(
      join(root, "compatibility/openjdk/tests", test.path),
      "utf8",
    ),
  }],
  mainClass: test.mainClass,
  args: test.args ?? [],
  validate: (result) => result.status === "completed" && result.exitCode === 0,
}));

const server = spawn(process.execPath, [join(root, "tests/browser/serve.mjs")], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("TraceJVM compatibility server did not start")),
    10_000,
  );
  server.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`TraceJVM compatibility server exited with ${code}`));
  });
  server.stdout.on("data", (chunk) => {
    if (String(chunk).includes("compatibility host")) {
      clearTimeout(timeout);
      resolve();
    }
  });
});

const reports = [];
try {
  for (const [engineName, configuration] of Object.entries(engines)) {
    if (!requested.has(engineName)) continue;
    process.stderr.write(`[compatibility] starting ${engineName}\n`);
    const browser = await configuration.engine.launch({ headless: true });
    const page = await browser.newPage(configuration.context);
    let activeCaseConsoleErrors;
    page.on("console", (message) => {
      if (activeCaseConsoleErrors && message.type() === "error") {
        activeCaseConsoleErrors.push(message.text());
      }
    });
    const browserReport = { engine: engineName, success: true, cases: [] };
    const startedAt = performance.now();
    try {
      const testUrl = experimentalHotAot
        ? `http://127.0.0.1:${port}/?experimentalHotAot=1`
        : `http://127.0.0.1:${port}/`;
      await page.goto(testUrl, { waitUntil: "load" });
      await page.waitForFunction(() => "traceJVMTest" in globalThis);
      await page.evaluate(() => globalThis.traceJVMTest.initialize());
      for (const test of [...smoke, ...openJdkCases].filter(
        ({ id }) => requestedCases.size === 0 || requestedCases.has(id),
      )) {
        const consoleErrors = [];
        activeCaseConsoleErrors = consoleErrors;
        const result = test.mode === "abort-recover"
          ? await page.evaluate(
              () => globalThis.traceJVMTest.abortAndRecover(),
            )
          : test.mode === "compile-run"
            ? await page.evaluate(
              async ({ sources, mainClass, args }) => {
                const compile = await globalThis.traceJVMTest.compile(sources);
                const firstRun = await globalThis.traceJVMTest.run(
                  compile.program,
                  mainClass,
                  args,
                );
                const secondRun = await globalThis.traceJVMTest.run(
                  compile.program,
                  mainClass,
                  ["twice"],
                );
                return { compile, firstRun, secondRun };
              },
              {
                sources: test.sources,
                mainClass: test.mainClass,
                args: test.args,
              },
              )
            : await page.evaluate(
              ({ sources, mainClass, args, systemProperties, processFiles }) =>
                globalThis.traceJVMTest.executeTimed(
                  sources,
                  mainClass,
                  args,
                  60_000,
                  systemProperties,
                  processFiles,
                ),
              {
                sources: test.sources,
                mainClass: test.mainClass,
                args: test.args,
                systemProperties: test.systemProperties,
                processFiles: test.processFiles,
              },
            );
        activeCaseConsoleErrors = undefined;
        const processFileConsoleErrors = test.id === "process-files-visible"
          ? consoleErrors.filter(fatalProcessFileConsoleMessage)
          : [];
        const passed =
          test.validate(result) &&
          processFileConsoleErrors.length === 0;
        browserReport.cases.push({
          id: test.id,
          passed,
          result,
          ...(test.id === "process-files-visible"
            ? { processFileConsoleErrors }
            : {}),
        });
        if (!passed) browserReport.success = false;
      }
    } catch (error) {
      browserReport.success = false;
      browserReport.fatal = error instanceof Error ? error.stack : String(error);
    } finally {
      browserReport.wallMs = performance.now() - startedAt;
      reports.push(browserReport);
      await browser.close();
      process.stderr.write(
        `[compatibility] finished ${engineName} in ${Math.round(browserReport.wallMs)}ms\n`,
      );
    }
  }
} finally {
  server.kill("SIGTERM");
}

mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(
  join(root, "reports/browser-compatibility.json"),
  `${JSON.stringify({
    measuredAt: new Date().toISOString(),
    openjdk: manifest.upstream,
    experiments: {
      hotAot: experimentalHotAot,
    },
    reports,
  }, null, 2)}\n`,
);
console.log(JSON.stringify(reports.map((report) => ({
  engine: report.engine,
  success: report.success,
  passed: report.cases.filter(({ passed }) => passed).length,
  total: report.cases.length,
  wallMs: Math.round(report.wallMs),
})), null, 2));

if (reports.some((report) => !report.success)) process.exitCode = 1;
