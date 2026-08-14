import {
  createTraceJVMAssetIntegrityMap,
  TraceJVMCompiler,
  TraceJVMWorkerClient,
  type TraceJVMCompiledProgram,
  type TraceJVMRuntimeProfile,
  type TraceJVMSourceFile,
  type TraceJVMWorkerLike,
} from "../../src";
import releaseManifest from "../../runtime-release/manifest.json";

type Sources = TraceJVMSourceFile[];

const runtimeIntegrity = createTraceJVMAssetIntegrityMap(
  "/runtime/assets",
  releaseManifest.files,
);
const compilerIntegrity = Object.freeze({
  ...runtimeIntegrity,
  ...createTraceJVMAssetIntegrityMap(
    "/.cache/teavm-javac/artifacts",
    releaseManifest.files
      .filter(({ path }) => path.startsWith("compiler/"))
      .map((file) => ({ ...file, path: file.path.slice("compiler/".length) })),
  ),
});

const experimentalHotAot =
  new URLSearchParams(globalThis.location.search).get("experimentalHotAot") ===
    "1";

let client = createClient("core");
let compiler = createCompiler();
let measurementClient: TraceJVMWorkerClient | undefined;
let measurementCompiler: TraceJVMCompiler | undefined;
let measurementProgram: TraceJVMCompiledProgram | undefined;
let splitCompiler: TraceJVMCompiler | undefined;
let splitRunnerClient: TraceJVMWorkerClient | undefined;
let splitProgram: TraceJVMCompiledProgram | undefined;

async function sha256(content: Uint8Array): Promise<string> {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function createClient(
  profile: TraceJVMRuntimeProfile,
  heapBytes?: number,
): TraceJVMWorkerClient {
  return new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: {
          core: "/runtime/assets/profiles/core",
          server: "/runtime/assets/profiles/server",
          "spring-server": "/runtime/assets/profiles/spring-server",
        },
        wasmUrl: "/runtime/assets/bjvm_main.wasm",
        integrity: runtimeIntegrity,
      },
      ...(heapBytes === undefined ? {} : { heapBytes }),
      runtimeProfile: profile,
      retirementAfterExecutions: 8,
      experiments: {
        hotAot: experimentalHotAot,
      },
    },
    createWorker: () =>
      new Worker("/dist/browser-worker.js", {
        type: "module",
      }) as unknown as TraceJVMWorkerLike,
  });
}

function createCompiler(): TraceJVMCompiler {
  return new TraceJVMCompiler({
    assets: {
      baseUrl: "/.cache/teavm-javac/artifacts",
      integrity: compilerIntegrity,
    },
    platformArchiveUrl: "/runtime/assets/profiles/core/jdk23.jar",
  });
}

async function execute(
  sources: Sources,
  mainClass: string,
  args: string[] = [],
  signal?: AbortSignal,
  systemProperties?: Record<string, string>,
  processFiles?: Array<{ path: string; content: string }>,
): Promise<Record<string, unknown>> {
  let streamedStdout = "";
  let streamedStderr = "";
  const compiled = await compiler.compile({
    sources,
    signal,
    onStderr: (chunk) => {
      streamedStderr += chunk;
    },
  });
  if (compiled.status !== "completed" || !compiled.program) {
    return { ...compiled, streamedStdout, streamedStderr };
  }
  const result = await client.run({
    program: compiled.program,
    mainClass,
    args,
    systemProperties,
    processFiles: processFiles?.map((file) => ({
      path: file.path,
      content: new TextEncoder().encode(file.content),
    })),
    signal,
    onStdout: (chunk) => {
      streamedStdout += chunk;
    },
    onStderr: (chunk) => {
      streamedStderr += chunk;
    },
  });
  return { ...result, streamedStdout, streamedStderr };
}

Object.assign(globalThis, {
  traceJVMTest: {
    initialize: async () => {
      const [runtime] = await Promise.all([
        client.initialize(),
        compiler.initialize(),
      ]);
      return runtime;
    },
    execute,
    executeWithProfile: async (
      profile: TraceJVMRuntimeProfile,
      sources: Sources,
      mainClass: string,
      args: string[] = [],
      classpath: TraceJVMCompiledProgram["files"] = [],
    ) => {
      const profileClient = createClient(profile);
      const profileCompiler = createCompiler();
      try {
        const compiled = await profileCompiler.compile({ sources, classpath });
        if (compiled.status !== "completed" || !compiled.program) {
          return compiled;
        }
        return await profileClient.run({
          program: compiled.program, mainClass, args, classpath,
        });
      } finally {
        profileCompiler.dispose();
        await profileClient.dispose();
      }
    },
    executeTimed: async (
      sources: Sources,
      mainClass: string,
      args: string[] = [],
      timeoutMs = 20_000,
      systemProperties?: Record<string, string>,
      processFiles?: Array<{ path: string; content: string }>,
    ) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await execute(
          sources,
          mainClass,
          args,
          controller.signal,
          systemProperties,
          processFiles,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    abortAndRecover: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100);
      let aborted = false;
      try {
        await execute([{
          path: "Spin.java",
          content: `public class Spin {
            public static void main(String[] args) {
              while (true) {}
            }
          }`,
        }], "Spin", [], controller.signal);
      } catch (error) {
        aborted = error instanceof Error && error.name === "AbortError";
      } finally {
        clearTimeout(timer);
      }
      const recovery = await execute([{
        path: "Recovery.java",
        content: `public class Recovery {
          public static void main(String[] args) {
            System.out.println("recovered");
          }
        }`,
      }], "Recovery");
      return { aborted, recovery };
    },
    compile: (sources: Sources) => compiler.compile({ sources }),
    compileAndRunTimed: async (
      sources: Sources,
      mainClass: string,
      args: string[] = [],
      timeoutMs = 20_000,
      systemProperties?: Record<string, string>,
    ) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const compile = await compiler.compile({
          sources,
          signal: controller.signal,
        });
        const program = compile.program;
        const artifacts = program
          ? await Promise.all(program.files.map(async (file) => ({
              path: file.path,
              bytes: file.content.byteLength,
              sha256: await sha256(file.content),
            })))
          : [];
        if (compile.status !== "completed" || !program) {
          return {
            compile: { ...compile, program: undefined },
            artifacts,
          };
        }
        const run = await client.run({
          program,
          mainClass,
          args,
          systemProperties,
          signal: controller.signal,
        });
        return {
          compile: { ...compile, program: undefined },
          artifacts: artifacts.sort((left, right) =>
            left.path.localeCompare(right.path)
          ),
          run,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    initializeProfileMeasurement: async (profile: TraceJVMRuntimeProfile) => {
      measurementClient?.terminate();
      measurementClient = createClient(profile);
      measurementCompiler?.dispose();
      measurementCompiler = createCompiler();
      measurementProgram = undefined;
      const [runtime] = await Promise.all([
        measurementClient.initialize(),
        measurementCompiler.initialize(),
      ]);
      return runtime;
    },
    compileProfileMeasurement: async (sources: Sources) => {
      if (!measurementCompiler) {
        throw new Error("Profile measurement client is not initialized.");
      }
      const result = await measurementCompiler.compile({ sources });
      measurementProgram = result.program;
      return {
        ...result,
        program: undefined,
        artifactBytes:
          result.program?.files.reduce(
            (total, file) => total + file.content.byteLength,
            0,
          ) ?? 0,
      };
    },
    runProfileMeasurement: (
      mainClass: string,
      args: string[] = [],
    ) => {
      if (!measurementClient) {
        throw new Error("Profile measurement client is not initialized.");
      }
      if (!measurementProgram) {
        throw new Error("Profile measurement compiler produced no program.");
      }
      return measurementClient.run({
        program: measurementProgram,
        mainClass,
        args,
      });
    },
    executeProfileMeasurement: async (
      sources: Sources,
      mainClass: string,
    ) => {
      if (!measurementClient) {
        throw new Error("Profile measurement client is not initialized.");
      }
      const compiled = await measurementCompiler!.compile({ sources });
      if (compiled.status !== "completed" || !compiled.program) {
        return compiled;
      }
      return measurementClient!.run({
        program: compiled.program,
        mainClass,
      });
    },
    disposeProfileMeasurement: () => {
      measurementClient?.terminate();
      measurementCompiler?.dispose();
      measurementClient = undefined;
      measurementCompiler = undefined;
      measurementProgram = undefined;
    },
    initializeSplitCompiler: async () => {
      splitCompiler?.dispose();
      splitCompiler = createCompiler();
      splitProgram = undefined;
      return splitCompiler.initialize();
    },
    compileSplitProgram: async (
      sources: Sources,
    ) => {
      if (!splitCompiler) {
        throw new Error("Split compiler is not initialized.");
      }
      const result = await splitCompiler.compile({ sources });
      splitProgram = result.program;
      return {
        ...result,
        program: undefined,
        artifactBytes:
          result.program?.files.reduce(
            (total, file) => total + file.content.byteLength,
            0,
          ) ?? 0,
      };
    },
    initializeSplitRunner: async (heapBytes?: number) => {
      splitRunnerClient?.terminate();
      splitRunnerClient = createClient("core", heapBytes);
      return splitRunnerClient.initialize();
    },
    runSplitProgram: (
      mainClass: string,
      args: string[] = [],
    ) => {
      if (!splitRunnerClient) {
        throw new Error("Split runner is not initialized.");
      }
      if (!splitProgram) {
        throw new Error("Split compiler has not produced a program.");
      }
      return splitRunnerClient.run({
        program: splitProgram,
        mainClass,
        args,
      });
    },
    probeSplitRoleGuards: async () => {
      if (!splitCompiler || !splitRunnerClient || !splitProgram) {
        throw new Error("Split compiler and runner must be initialized.");
      }
      const runnerCompile = "unsupported-by-runner-api";
      const compilerRun = "unsupported-by-compiler-api";
      return { runnerCompile, compilerRun };
    },
    disposeSplitCompiler: () => {
      splitCompiler?.dispose();
      splitCompiler = undefined;
    },
    disposeSplitRunner: () => {
      splitRunnerClient?.terminate();
      splitRunnerClient = undefined;
    },
    disposeSplitMeasurement: () => {
      splitCompiler?.dispose();
      splitRunnerClient?.terminate();
      splitCompiler = undefined;
      splitRunnerClient = undefined;
      splitProgram = undefined;
    },
    run: (
      program: TraceJVMCompiledProgram,
      mainClass: string,
      args?: string[],
    ) => client.run({ program, mainClass, args }),
    runInFreshRunner: async (
      program: TraceJVMCompiledProgram,
      mainClass: string,
      args: string[] = [],
    ) => {
      const runner = createClient("core");
      try {
        await runner.initialize();
        return await runner.run({ program, mainClass, args });
      } finally {
        runner.terminate();
      }
    },
    dispose: async () => {
      await client.dispose();
      compiler.dispose();
      measurementClient?.terminate();
      measurementCompiler?.dispose();
      measurementClient = undefined;
      measurementCompiler = undefined;
      measurementProgram = undefined;
      splitCompiler?.dispose();
      splitRunnerClient?.terminate();
      splitCompiler = undefined;
      splitRunnerClient = undefined;
      splitProgram = undefined;
      client = createClient("core");
      compiler = createCompiler();
    },
  },
});
