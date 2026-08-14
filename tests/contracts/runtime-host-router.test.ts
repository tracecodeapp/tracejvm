import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeHostRouter } from "../../engine/bjvm/js/bjvm2";

test("host descriptors are capabilities owned by one JVM context", async () => {
  const dispatched: unknown[] = [];
  const dispatchSync = (request: unknown): unknown => {
    dispatched.push(request);
    const operation = (request as { operation?: string }).operation;
    if (operation === "open") return { fd: 7 };
    if (operation === "read") return { bytes: new Uint8Array() };
    return {};
  };
  const dispatchAsync = async (request: unknown): Promise<unknown> => {
    dispatched.push(request);
    return { fd: 8, remoteAddress: { host: "127.0.0.1", port: 443 } };
  };
  const router = new RuntimeHostRouter({
    runtimeUrl: "https://runtime.invalid/",
    additionalRuntimeFiles: [],
  });
  const first = router.createContext({
    classpath: "/app",
    hostDispatchSync: dispatchSync,
    hostDispatchAsync: dispatchAsync,
  });
  const second = router.createContext({
    classpath: "/app",
    hostDispatchSync: dispatchSync,
    hostDispatchAsync: dispatchAsync,
  });

  const opened = router.run(first, () => router.dispatchSync({
    service: "posix",
    operation: "open",
    payload: { path: "/workspace/input.txt" },
  })) as { fd: number };
  assert.notEqual(opened.fd, 7);
  router.run(first, () => router.dispatchSync({
    service: "posix",
    operation: "read",
    payload: { fd: opened.fd, maxBytes: 1 },
  }));
  assert.deepEqual(dispatched.at(-1), {
    service: "posix",
    operation: "read",
    payload: { fd: 7, maxBytes: 1 },
  });
  const secondOpened = router.run(second, () => router.dispatchSync({
    service: "posix",
    operation: "open",
    payload: { path: "/workspace/other.txt" },
  })) as { fd: number };
  assert.notEqual(secondOpened.fd, opened.fd);

  const countBeforeForgery = dispatched.length;
  assert.throws(
    () => router.run(first, () => router.dispatchSync({
      service: "posix",
      operation: "read",
      payload: { fd: 99, maxBytes: 1 },
    })),
    (error: unknown) => (error as { name?: string }).name === "EBADF",
  );
  assert.throws(
    () => router.run(second, () => router.dispatchSync({
      service: "posix",
      operation: "read",
      payload: { fd: opened.fd, maxBytes: 1 },
    })),
    (error: unknown) => (error as { name?: string }).name === "EBADF",
  );
  assert.equal(dispatched.length, countBeforeForgery);

  const accepted = await router.run(first, () => router.dispatchAsync({
    service: "posix",
    operation: "accept",
    payload: { fd: opened.fd },
  }, first.id)) as { fd: number };
  assert.notEqual(accepted.fd, 8);
  router.run(first, () => router.dispatchSync({
    service: "posix",
    operation: "read",
    payload: { fd: accepted.fd, maxBytes: 1 },
  }));

  router.releaseContext(first);
  const closeRequests = dispatched.filter((request) =>
    (request as { operation?: string }).operation === "close"
  );
  assert.deepEqual(closeRequests, [
    { service: "posix", operation: "close", payload: { fd: 7 } },
    { service: "posix", operation: "close", payload: { fd: 8 } },
  ]);
  await assert.rejects(
    router.dispatchAsync({ service: "posix", operation: "wait" }, first.id),
    (error: unknown) => (error as { name?: string }).name === "ENOSYS",
  );
  router.releaseContext(second);
});

test("only explicitly enabled standard descriptors are pre-authorized", () => {
  const dispatched: unknown[] = [];
  const router = new RuntimeHostRouter({
    runtimeUrl: "https://runtime.invalid/",
    additionalRuntimeFiles: [],
  });
  const withoutStandardDescriptors = router.createContext({
    classpath: "/app",
    hostDispatchSync: (request) => dispatched.push(request),
  });
  const withStandardDescriptors = router.createContext({
    classpath: "/app",
    hostStandardDescriptors: true,
    hostDispatchSync: (request) => dispatched.push(request),
  });

  assert.throws(
    () => router.run(withoutStandardDescriptors, () => router.dispatchSync({
      service: "posix",
      operation: "write",
      payload: { fd: 1, bytes: new Uint8Array([1]) },
    })),
    (error: unknown) => (error as { name?: string }).name === "EBADF",
  );
  assert.doesNotThrow(
    () => router.run(withStandardDescriptors, () => router.dispatchSync({
      service: "posix",
      operation: "write",
      payload: { fd: 1, bytes: new Uint8Array([1]) },
    })),
  );
});
