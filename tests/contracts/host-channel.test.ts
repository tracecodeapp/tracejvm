import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  failTraceJVMHostCall,
  makeTraceJVMHostChannel,
  respondToTraceJVMHostCall,
  type TraceJVMHostChannel,
} from "../../src/host-channel";
import type { TraceJVMHostRequest } from "../../src/host";

interface FixtureRequest {
  readonly type: "request";
  readonly request: TraceJVMHostRequest;
}

interface FixtureResult {
  readonly type: "result";
  readonly value: unknown;
}

interface FixtureFailure {
  readonly type: "failure";
  readonly name: string;
  readonly message: string;
}

type FixtureMessage = FixtureRequest | FixtureResult | FixtureFailure;

function spawnFixture(channel: TraceJVMHostChannel): Worker {
  return new Worker(
    new URL("./fixtures/host-channel-worker.ts", import.meta.url),
    { workerData: channel },
  );
}

function nextMessage(worker: Worker): Promise<FixtureMessage> {
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
}

test(
  "synchronous Worker calls are serviced asynchronously with binary values",
  { timeout: 5_000 },
  async (context) => {
    const channel = makeTraceJVMHostChannel();
    const worker = spawnFixture(channel);
    context.after(() => void worker.terminate());
    worker.postMessage({
      type: "dispatch",
      request: {
        service: "posix",
        operation: "read",
        payload: { fd: 4, length: 3 },
      },
    });

    const request = await nextMessage(worker);
    assert.deepEqual(request, {
      type: "request",
      request: {
        service: "posix",
        operation: "read",
        payload: { fd: 4, length: 3 },
      },
    });
    respondToTraceJVMHostCall(channel, {
      bytes: new Uint8Array([0, 127, 255]),
    });

    const result = await nextMessage(worker);
    assert.equal(result.type, "result");
    assert.deepEqual(
      (result as FixtureResult).value,
      { bytes: new Uint8Array([0, 127, 255]) },
    );
  },
);

test(
  "host failures preserve their error identity across the Worker boundary",
  { timeout: 5_000 },
  async (context) => {
    const channel = makeTraceJVMHostChannel();
    const worker = spawnFixture(channel);
    context.after(() => void worker.terminate());
    worker.postMessage({
      type: "dispatch",
      request: { service: "posix", operation: "open" },
    });

    assert.equal((await nextMessage(worker)).type, "request");
    failTraceJVMHostCall(
      channel,
      Object.assign(new Error("permission denied"), { name: "EACCES" }),
    );

    assert.deepEqual(await nextMessage(worker), {
      type: "failure",
      name: "EACCES",
      message: "permission denied",
    });
  },
);

test(
  "a host channel admits only one synchronous caller at a time",
  { timeout: 5_000 },
  async (context) => {
    const channel = makeTraceJVMHostChannel();
    const first = spawnFixture(channel);
    const second = spawnFixture(channel);
    context.after(() => {
      void first.terminate();
      void second.terminate();
    });
    const request = {
      type: "dispatch" as const,
      request: { service: "posix", operation: "open" },
    };
    first.postMessage(request);
    second.postMessage(request);

    const firstMessages = await Promise.all([
      nextMessage(first),
      nextMessage(second),
    ]);
    assert.deepEqual(
      firstMessages.map((message) => message.type).sort(),
      ["failure", "request"],
    );
    const rejected = firstMessages.find(
      (message): message is FixtureFailure => message.type === "failure",
    );
    assert.match(rejected?.message ?? "", /Concurrent TraceJVM host calls/);

    respondToTraceJVMHostCall(channel, { fd: 7 });
    const admittedWorker = firstMessages[0].type === "request" ? first : second;
    assert.deepEqual(await nextMessage(admittedWorker), {
      type: "result",
      value: { fd: 7 },
    });
  },
);

test("host channels reject capacities too small for bounded failures", () => {
  assert.throws(
    () => makeTraceJVMHostChannel(255),
    /at least 256 bytes/,
  );
});

test(
  "unserializable host responses fail the call instead of blocking the VM",
  { timeout: 5_000 },
  async (context) => {
    const channel = makeTraceJVMHostChannel();
    const worker = spawnFixture(channel);
    context.after(() => void worker.terminate());
    worker.postMessage({
      type: "dispatch",
      request: { service: "test", operation: "circular" },
    });

    assert.equal((await nextMessage(worker)).type, "request");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    respondToTraceJVMHostCall(channel, circular);

    const result = await nextMessage(worker);
    assert.equal(result.type, "failure");
    assert.match(
      (result as FixtureFailure).message,
      /not serializable/,
    );
  },
);
