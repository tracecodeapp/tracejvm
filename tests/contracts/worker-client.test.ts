import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";

import {
  TraceJVMAbortedError,
  TraceJVMCompilerWorkerClient,
  TraceJVMWorkerService,
  TraceJVMWorkerClient,
  makeTraceJVMWorkerLayer,
  type TraceJVMWorkerLike,
  type TraceJVMWorkerRequest,
  type TraceJVMWorkerResponse,
} from "../../src";

const TEST_ASSET_INTEGRITY = Object.freeze({});

class FakeWorker implements TraceJVMWorkerLike {
  readonly messages: TraceJVMWorkerRequest[] = [];
  terminated = 0;
  private readonly messageListeners = new Set<
    (event: MessageEvent<TraceJVMWorkerResponse>) => void
  >();
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>();

  postMessage(message: TraceJVMWorkerRequest): void {
    this.messages.push(message);
  }

  addEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<TraceJVMWorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: MessageEvent<TraceJVMWorkerResponse>) => void,
      );
    } else {
      this.errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  removeEventListener(
    type: "message" | "error",
    listener:
      | ((event: MessageEvent<TraceJVMWorkerResponse>) => void)
      | ((event: ErrorEvent) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.delete(
        listener as (event: MessageEvent<TraceJVMWorkerResponse>) => void,
      );
    } else {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void);
    }
  }

  terminate(): void {
    this.terminated += 1;
  }

  reply(message: TraceJVMWorkerResponse): void {
    const event = { data: message } as MessageEvent<TraceJVMWorkerResponse>;
    for (const listener of this.messageListeners) listener(event);
  }
}

function createClient(worker: FakeWorker): TraceJVMWorkerClient {
  return new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: {
          core: "/tracejvm/profiles/core",
        },
        wasmUrl: "/tracejvm/bjvm_main.wasm",
        integrity: TEST_ASSET_INTEGRITY,
      },
    },
    createWorker: () => worker,
  });
}

async function waitForPostedMessage(
  worker: FakeWorker,
  type: TraceJVMWorkerRequest["type"],
): Promise<TraceJVMWorkerRequest> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for (let index = worker.messages.length - 1; index >= 0; index -= 1) {
      const message = worker.messages[index];
      if (message.type === type) return message;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Worker did not receive ${type}`);
}

test("Worker client initializes once and routes streamed output", async () => {
  const worker = new FakeWorker();
  const client = createClient(worker);
  const initialization = client.initialize();
  assert.equal(worker.messages[0]?.type, "initialize");
  worker.reply({
    id: worker.messages[0].id,
    type: "initialized",
    result: { initializeMs: 12 },
  });
  assert.deepEqual(await initialization, { initializeMs: 12 });

  let stdout = "";
  const execution = client.run({
    program: { files: [] },
    mainClass: "Main",
    onStdout: (chunk) => {
      stdout += chunk;
    },
  });
  const request = await waitForPostedMessage(worker, "run");
  worker.reply({
    id: request.id,
    type: "stream",
    stream: "stdout",
    chunk: "hello\n",
  });
  worker.reply({
    id: request.id,
    type: "run-result",
    result: {
      status: "completed",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
      timings: {
        runtimeInitMs: 12,
        queueMs: 0,
        compileAndRunMs: 1,
        totalMs: 1,
      },
      isolation: {
        status: "clean",
        restored: ["system-properties"],
        taintReasons: [],
        hardBoundaryRecommended: false,
      },
      retirementRecommended: false,
    },
  });
  assert.equal((await execution).exitCode, 0);
  assert.equal(stdout, "hello\n");
  assert.equal(worker.messages.filter(({ type }) => type === "initialize").length, 1);
});

test("compiler Worker client owns only persistent compilation", async () => {
  const worker = new FakeWorker();
  const client = new TraceJVMCompilerWorkerClient({
    compiler: {
      assets: {
        baseUrl: "/tracejvm/compiler",
        integrity: TEST_ASSET_INTEGRITY,
      },
      platformArchiveUrl: "/tracejvm/profiles/core/jdk23.jar",
      platformClasspath: [{
        path: "tracekernel-api.jar",
        url: "/tracejvm/profiles/core/tracekernel-api.jar",
      }],
    },
    createWorker: () => worker,
  });

  const initialization = client.initialize();
  const initializeRequest = worker.messages[0];
  assert.equal(initializeRequest?.type, "initialize-compiler");
  worker.reply({
    id: initializeRequest.id,
    type: "compiler-initialized",
    result: { initializeMs: 7 },
  });
  assert.deepEqual(await initialization, { initializeMs: 7 });

  const compilation = client.compile({
    sources: [{ path: "Main.java", content: "class Main {}" }],
  });
  const compileRequest = await waitForPostedMessage(worker, "compile");
  worker.reply({
    id: compileRequest.id,
    type: "compile-result",
    result: {
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      program: { files: [] },
      diagnostics: [],
      timings: {
        compilerInitMs: 7,
        queueMs: 0,
        compileMs: 1,
        totalMs: 1,
      },
    },
  });

  assert.equal((await compilation).status, "completed");
  assert.equal(
    worker.messages.filter(({ type }) => type === "initialize-compiler").length,
    1,
  );
  assert.equal(
    worker.messages.some(({ type }) =>
      type === "initialize" || type === "run"
    ),
    false,
  );
});

test("compiler Worker aborts terminate synchronous compilation", async () => {
  const worker = new FakeWorker();
  const client = new TraceJVMCompilerWorkerClient({
    compiler: {
      assets: {
        baseUrl: "/tracejvm/compiler",
        integrity: TEST_ASSET_INTEGRITY,
      },
      platformArchiveUrl: "/tracejvm/profiles/core/jdk23.jar",
    },
    createWorker: () => worker,
  });
  const controller = new AbortController();
  const initialization = client.initialize(controller.signal);

  controller.abort();

  await assert.rejects(initialization, TraceJVMAbortedError);
  assert.equal(worker.terminated, 1);
  assert.equal(
    worker.messages.some(({ type }) => type === "cancel"),
    false,
  );
});

test("Worker client services host calls outside the execution Worker", async () => {
  const worker = new FakeWorker();
  const calls: unknown[] = [];
  const client = new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: {
          core: "/tracejvm/profiles/core",
        },
        wasmUrl: "/tracejvm/bjvm_main.wasm",
        integrity: TEST_ASSET_INTEGRITY,
      },
    },
    createWorker: () => worker,
    host: {
      async dispatch(request) {
        calls.push(request);
        return { fd: 7 };
      },
    },
  });

  const initialization = client.initialize();
  const initializeRequest = worker.messages[0];
  assert.equal(initializeRequest?.type, "initialize");
  assert.ok(
    initializeRequest.type === "initialize" && initializeRequest.hostChannel,
  );
  worker.reply({
    id: initializeRequest.id,
    type: "initialized",
    result: { initializeMs: 1 },
  });
  await initialization;

  const header = new Int32Array(initializeRequest.hostChannel.buffer, 0, 2);
  // The real execution Worker acquires the channel before it posts a
  // synchronous host-call message. Model that half of the protocol here.
  assert.equal(Atomics.compareExchange(header, 0, 0, 4), 0);
  worker.reply({
    id: 99,
    type: "host-call",
    request: {
      service: "posix",
      operation: "open",
      payload: { path: "/workspace/Main.java" },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{
    service: "posix",
    operation: "open",
    payload: { path: "/workspace/Main.java" },
  }]);
  assert.equal(Atomics.load(header, 0), 1);
  assert.ok(Atomics.load(header, 1) > 0);

  client.terminate();
  assert.equal(Atomics.load(header, 0), 3);
});

test("Worker client returns concurrent asynchronous host calls by call id", async () => {
  const worker = new FakeWorker();
  const resolvers = new Map<string, (value: unknown) => void>();
  const client = new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: { core: "/tracejvm/profiles/core" },
        wasmUrl: "/tracejvm/bjvm_main.wasm",
        integrity: TEST_ASSET_INTEGRITY,
      },
    },
    createWorker: () => worker,
    host: {
      dispatch(request) {
        return new Promise((resolve) => {
          resolvers.set(request.operation, resolve);
        });
      },
    },
  });

  const initialization = client.initialize();
  const initializeRequest = worker.messages[0];
  assert.equal(initializeRequest?.type, "initialize");
  assert.ok(initializeRequest);
  worker.reply({
    id: initializeRequest.id,
    type: "initialized",
    result: { initializeMs: 1 },
  });
  await initialization;

  worker.reply({
    id: 41,
    type: "host-call-async",
    request: { service: "posix", operation: "first" },
  });
  worker.reply({
    id: 42,
    type: "host-call-async",
    request: { service: "posix", operation: "second" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  resolvers.get("second")?.({ exitCode: 2 });
  resolvers.get("first")?.({ exitCode: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    worker.messages.filter(
      (message) => message.type === "host-response-async",
    ),
    [
      {
        id: 42,
        type: "host-response-async",
        response: { ok: true, value: { exitCode: 2 } },
      },
      {
        id: 41,
        type: "host-response-async",
        response: { ok: true, value: { exitCode: 1 } },
      },
    ],
  );
});

test("Worker client preserves asynchronous host error codes", async () => {
  const worker = new FakeWorker();
  const client = new TraceJVMWorkerClient({
    engine: {
      assets: {
        runtimeProfileBaseUrls: { core: "/tracejvm/profiles/core" },
        wasmUrl: "/tracejvm/bjvm_main.wasm",
        integrity: TEST_ASSET_INTEGRITY,
      },
    },
    createWorker: () => worker,
    host: {
      dispatch() {
        throw Object.assign(new Error("no such child"), {
          name: "SystemError",
          code: "ECHILD",
        });
      },
    },
  });

  const initialization = client.initialize();
  const initializeRequest = worker.messages[0];
  assert.ok(initializeRequest);
  worker.reply({
    id: initializeRequest.id,
    type: "initialized",
    result: { initializeMs: 1 },
  });
  await initialization;

  worker.reply({
    id: 99,
    type: "host-call-async",
    request: { service: "posix", operation: "wait" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(worker.messages.at(-1), {
    id: 99,
    type: "host-response-async",
    response: {
      ok: false,
      error: {
        name: "SystemError",
        message: "no such child",
        code: "ECHILD",
      },
    },
  });
});

test("abort terminates the Worker as the hard isolation boundary", async () => {
  const worker = new FakeWorker();
  const client = createClient(worker);
  const initialization = client.initialize();
  worker.reply({
    id: worker.messages[0].id,
    type: "initialized",
    result: { initializeMs: 1 },
  });
  await initialization;

  const controller = new AbortController();
  const execution = client.run({
    program: { files: [] },
    mainClass: "Loop",
    signal: controller.signal,
  });
  await waitForPostedMessage(worker, "run");
  controller.abort();
  await assert.rejects(
    execution,
    (error) =>
      error instanceof TraceJVMAbortedError && error.name === "AbortError",
  );
  assert.equal(worker.terminated, 1);
});

test("safe default retires an idle Worker at the engine boundary", async () => {
  const worker = new FakeWorker();
  const client = createClient(worker);
  const initialization = client.initialize();
  worker.reply({
    id: worker.messages[0].id,
    type: "initialized",
    result: { initializeMs: 1 },
  });
  await initialization;

  const execution = client.run({
    program: { files: [] },
    mainClass: "Main",
  });
  const request = await waitForPostedMessage(worker, "run");
  worker.reply({
    id: request.id,
    type: "run-result",
    result: {
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timings: {
        runtimeInitMs: 1,
        queueMs: 0,
        compileAndRunMs: 1,
        totalMs: 1,
      },
      isolation: {
        status: "tainted",
        restored: [],
        taintReasons: ["application-thread-created"],
        hardBoundaryRecommended: true,
      },
      retirementRecommended: true,
    },
  });
  await execution;
  assert.equal(worker.terminated, 1);

  const nextInitialization = client.initialize();
  const nextRequest = worker.messages.at(-1);
  assert.equal(nextRequest?.type, "initialize");
  assert.ok(nextRequest);
  worker.reply({
    id: nextRequest.id,
    type: "initialized",
    result: { initializeMs: 2 },
  });
  assert.deepEqual(await nextInitialization, { initializeMs: 2 });
});

test("Effect service owns the Worker as a scoped resource", async () => {
  const worker = new FakeWorker();
  const layer = makeTraceJVMWorkerLayer({
    engine: {
      assets: {
        runtimeProfileBaseUrls: {
          core: "/tracejvm/profiles/core",
        },
        wasmUrl: "/tracejvm/bjvm_main.wasm",
        integrity: TEST_ASSET_INTEGRITY,
      },
    },
    createWorker: () => worker,
  });

  const program = Effect.gen(function* () {
    const client = yield* TraceJVMWorkerService;
    const initialization = client.initialize();
    worker.reply({
      id: worker.messages[0].id,
      type: "initialized",
      result: { initializeMs: 3 },
    });
    return yield* Effect.promise(() => initialization);
  });

  assert.deepEqual(
    await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer)))),
    { initializeMs: 3 },
  );
  assert.equal(worker.terminated, 1);
});
