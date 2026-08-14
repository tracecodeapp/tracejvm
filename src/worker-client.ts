import type {
  TraceJVMCompileRequest,
  TraceJVMCompileResult,
  TraceJVMExecuteResult,
  TraceJVMOptions,
  TraceJVMRunRequest,
} from "./engine";
import type { TraceJVMCompilerOptions } from "./compiler";
import type { TraceJVMWorkerHost } from "./host";
import {
  closeTraceJVMHostChannel,
  failTraceJVMHostCall,
  makeTraceJVMHostChannel,
  respondToTraceJVMHostCall,
  type TraceJVMHostChannel,
} from "./host-channel";
import * as Effect from "effect/Effect";
import {
  TraceJVMAbortedError,
  TraceJVMWorkerCrashedError,
  TraceJVMWorkerReportedError,
  TraceJVMWorkerTerminatedError,
  type TraceJVMWorkerError,
} from "./errors";
import { runTraceJVMEffect } from "./run-effect";
import {
  validateTraceJVMCompileResources,
  validateTraceJVMRunResources,
} from "./resource-limits";
import type {
  TraceJVMWorkerRequest,
  TraceJVMWorkerResponse,
} from "./worker-protocol";

export interface TraceJVMWorkerLike {
  postMessage(message: TraceJVMWorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TraceJVMWorkerResponse>) => void,
  ): void;
  addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<TraceJVMWorkerResponse>) => void,
  ): void;
  removeEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  terminate(): void;
}

export interface TraceJVMWorkerClientOptions {
  engine: Omit<TraceJVMOptions, "host">;
  createWorker: () => TraceJVMWorkerLike;
  /** Host capabilities serviced outside the untrusted execution Worker. */
  host?: TraceJVMWorkerHost;
  /** Bounded response payload capacity. Defaults to 1 MiB. */
  hostResponseByteCapacity?: number;
  /**
   * b-jvm cannot safely interrupt every in-flight native or interpreter path.
   * The default therefore terminates the Worker on abort. Set false only when
   * queued-only cooperative cancellation is an acceptable explicit tradeoff.
   */
  hardAbort?: boolean;
  /**
   * Recycle an idle Worker when the engine reaches its configured execution
   * lifetime. This is the safe default. Set false only for an explicitly
   * unsafe long-lived runtime where retaining all VM state is acceptable.
   */
  retireAutomatically?: boolean;
}

export interface TraceJVMCompilerWorkerClientOptions {
  compiler: TraceJVMCompilerOptions;
  createWorker: () => TraceJVMWorkerLike;
}

interface PendingOperation {
  resolve: (value: unknown) => void;
  reject: (error: TraceJVMWorkerError) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  detachAbort?: () => void;
}

type TraceJVMWorkerRequestBody =
  TraceJVMWorkerRequest extends infer Request
    ? Request extends { id: number }
      ? Omit<Request, "id">
      : never
    : never;

function abortError(): TraceJVMAbortedError {
  return new TraceJVMAbortedError();
}

function workerError(event: ErrorEvent): TraceJVMWorkerCrashedError {
  return new TraceJVMWorkerCrashedError({
    workerMessage: event.message || undefined,
    filename: event.filename || undefined,
    lineno: event.lineno || undefined,
    colno: event.colno || undefined,
  });
}

export class TraceJVMWorkerClient {
  private worker: TraceJVMWorkerLike | undefined;
  private initializationGate: Promise<{ initializeMs: number }> | undefined;
  private nextId = 0;
  private hostChannel: TraceJVMHostChannel | undefined;
  private readonly pending = new Map<number, PendingOperation>();
  private readonly onMessage = (
    event: MessageEvent<TraceJVMWorkerResponse>,
  ): void => {
    const message = event.data;
    if (message.type === "host-call-async") {
      const worker = this.worker;
      const host = this.options.host;
      if (!worker) return;
      if (!host) {
        postAsyncHostFailure(
          worker,
          message.id,
          new Error("TraceJVM Worker requested an unavailable host service."),
        );
        return;
      }
      void Promise.resolve()
        .then(() => host.dispatch(message.request))
        .then(
          (value) => postAsyncHostSuccess(worker, message.id, value),
          (cause) => postAsyncHostFailure(worker, message.id, cause),
        );
      return;
    }
    if (message.type === "host-call") {
      const channel = this.hostChannel;
      const host = this.options.host;
      if (!channel || !host) {
        if (channel) {
          failTraceJVMHostCall(
            channel,
            new Error("TraceJVM Worker requested an unavailable host service."),
          );
        }
        return;
      }
      void Promise.resolve()
        .then(() => host.dispatch(message.request))
        .then(
          (value) => respondToTraceJVMHostCall(channel, value),
          (error) => failTraceJVMHostCall(channel, error),
        );
      return;
    }
    const operation = this.pending.get(message.id);
    if (!operation) return;
    if (message.type === "stream") {
      if (message.stream === "stdout") operation.onStdout?.(message.chunk);
      else operation.onStderr?.(message.chunk);
      return;
    }
    this.pending.delete(message.id);
    operation.detachAbort?.();
    if (message.type === "error") {
      operation.reject(new TraceJVMWorkerReportedError(message.error));
      return;
    }
    if (message.type === "disposed") {
      operation.resolve(undefined);
      return;
    }
    if (!("result" in message)) {
      operation.resolve(message);
      return;
    }
    operation.resolve(message.result);
    if (
      this.options.retireAutomatically !== false &&
      "retirementRecommended" in message.result &&
      message.result.retirementRecommended &&
      this.pending.size === 0
    ) {
      this.close();
    }
  };
  private readonly onError = (event: ErrorEvent): void => {
    this.close(workerError(event));
  };

  constructor(private readonly options: TraceJVMWorkerClientOptions) {}

  initializeEffect(
    signal?: AbortSignal,
  ): Effect.Effect<{ initializeMs: number }, TraceJVMWorkerError> {
    return Effect.tryPromise({
      try: (effectSignal) =>
        this.initializePromise(combineSignals(signal, effectSignal)),
      catch: asWorkerError,
    });
  }

  runEffect(
    request: TraceJVMRunRequest,
  ): Effect.Effect<TraceJVMExecuteResult, TraceJVMWorkerError> {
    return Effect.tryPromise({
      try: (effectSignal) =>
        this.runPromise({
          ...request,
          signal: combineSignals(request.signal, effectSignal),
        }),
      catch: asWorkerError,
    });
  }

  disposeEffect(): Effect.Effect<void, TraceJVMWorkerError> {
    return Effect.tryPromise({
      try: () => this.disposePromise(),
      catch: asWorkerError,
    });
  }

  initialize(signal?: AbortSignal): Promise<{ initializeMs: number }> {
    return runTraceJVMEffect(this.initializeEffect(signal));
  }

  run(request: TraceJVMRunRequest): Promise<TraceJVMExecuteResult> {
    return runTraceJVMEffect(this.runEffect(request));
  }

  dispose(): Promise<void> {
    return runTraceJVMEffect(this.disposeEffect());
  }

  private async initializePromise(
    signal?: AbortSignal,
  ): Promise<{ initializeMs: number }> {
    if (this.initializationGate) return this.initializationGate;
    const hostChannel = this.options.host
      ? this.ensureHostChannel()
      : undefined;
    const promise = this.request<{ initializeMs: number }>(
      {
        type: "initialize",
        options: this.options.engine,
        ...(hostChannel ? { hostChannel } : {}),
      },
      signal,
    );
    this.initializationGate = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.initializationGate === promise) this.initializationGate = undefined;
      throw error;
    }
  }

  private async runPromise(
    request: TraceJVMRunRequest,
  ): Promise<TraceJVMExecuteResult> {
    validateTraceJVMRunResources(request, this.options.engine.limits);
    await this.initializePromise(request.signal);
    const { signal, onStdout, onStderr, ...serializable } = request;
    return this.request<TraceJVMExecuteResult>(
      { type: "run", request: serializable },
      signal,
      onStdout,
      onStderr,
    );
  }

  private async disposePromise(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.request<void>({ type: "dispose" });
    } finally {
      this.close();
    }
  }

  terminate(): void {
    this.close(new TraceJVMWorkerTerminatedError());
  }

  private ensureWorker(): TraceJVMWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    this.worker = worker;
    return worker;
  }

  private ensureHostChannel(): TraceJVMHostChannel {
    this.hostChannel ??= makeTraceJVMHostChannel(
      this.options.hostResponseByteCapacity,
    );
    return this.hostChannel;
  }

  private request<Result>(
    body: TraceJVMWorkerRequestBody,
    signal?: AbortSignal,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<Result> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise<Result>((resolve, reject) => {
      const operation: PendingOperation = {
        resolve: (value) => resolve(value as Result),
        reject,
        onStdout,
        onStderr,
      };
      if (signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          if (this.options.hardAbort ?? true) {
            this.close(abortError());
          } else {
            worker.postMessage({ id: ++this.nextId, type: "cancel", targetId: id });
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.detachAbort = () =>
          signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, operation);
      worker.postMessage({ id, ...body } as TraceJVMWorkerRequest);
    });
  }

  private close(error?: TraceJVMWorkerError): void {
    const worker = this.worker;
    if (worker) {
      worker.removeEventListener("message", this.onMessage);
      worker.removeEventListener("error", this.onError);
      worker.terminate();
    }
    this.worker = undefined;
    this.initializationGate = undefined;
    if (this.hostChannel) {
      closeTraceJVMHostChannel(this.hostChannel);
      this.hostChannel = undefined;
    }
    if (error) {
      for (const operation of this.pending.values()) {
        operation.detachAbort?.();
        operation.reject(error);
      }
    }
    this.pending.clear();
  }
}

/**
 * Persistent TeaVM-javac compiler hosted in its own Worker.
 *
 * This client intentionally has no runner or process API. Embedders own runner
 * Workers separately so retiring learner state can never discard the warm
 * compiler, and a runner failure cannot poison compilation.
 */
export class TraceJVMCompilerWorkerClient {
  private worker: TraceJVMWorkerLike | undefined;
  private initializationGate: Promise<{ initializeMs: number }> | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, PendingOperation>();

  private readonly onMessage = (
    event: MessageEvent<TraceJVMWorkerResponse>,
  ): void => {
    const message = event.data;
    const operation = this.pending.get(message.id);
    if (!operation) return;
    if (message.type === "stream") {
      if (message.stream === "stdout") operation.onStdout?.(message.chunk);
      else operation.onStderr?.(message.chunk);
      return;
    }
    this.pending.delete(message.id);
    operation.detachAbort?.();
    if (message.type === "error") {
      operation.reject(new TraceJVMWorkerReportedError(message.error));
      return;
    }
    if (message.type === "disposed") operation.resolve(undefined);
    else operation.resolve("result" in message ? message.result : message);
  };

  private readonly onError = (event: ErrorEvent): void => {
    this.close(workerError(event));
  };

  constructor(
    private readonly options: TraceJVMCompilerWorkerClientOptions,
  ) {}

  async initialize(signal?: AbortSignal): Promise<{ initializeMs: number }> {
    if (this.initializationGate) return this.initializationGate;
    const promise = this.request<{ initializeMs: number }>(
      {
        type: "initialize-compiler",
        options: this.options.compiler,
      },
      signal,
    );
    this.initializationGate = promise;
    try {
      return await promise;
    } catch (error) {
      if (this.initializationGate === promise) {
        this.initializationGate = undefined;
      }
      throw error;
    }
  }

  async compile(
    request: TraceJVMCompileRequest,
  ): Promise<TraceJVMCompileResult> {
    validateTraceJVMCompileResources(request, this.options.compiler.limits);
    await this.initialize(request.signal);
    const { signal, onStdout, onStderr, ...serializable } = request;
    return this.request<TraceJVMCompileResult>(
      { type: "compile", request: serializable },
      signal,
      onStdout,
      onStderr,
    );
  }

  async dispose(): Promise<void> {
    if (!this.worker) return;
    try {
      await this.request<void>({ type: "dispose" });
    } finally {
      this.close();
    }
  }

  terminate(): void {
    this.close(new TraceJVMWorkerTerminatedError());
  }

  private ensureWorker(): TraceJVMWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    this.worker = worker;
    return worker;
  }

  private request<Result>(
    body: TraceJVMWorkerRequestBody,
    signal?: AbortSignal,
    onStdout?: (chunk: string) => void,
    onStderr?: (chunk: string) => void,
  ): Promise<Result> {
    if (signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise<Result>((resolve, reject) => {
      const operation: PendingOperation = {
        resolve: (value) => resolve(value as Result),
        reject,
        onStdout,
        onStderr,
      };
      if (signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          // TeaVM-javac is synchronous once compilation begins, so a compiler
          // Worker cannot observe a queued cooperative cancellation message.
          this.close(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        operation.detachAbort = () =>
          signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, operation);
      worker.postMessage({ id, ...body } as TraceJVMWorkerRequest);
    });
  }

  private close(error?: TraceJVMWorkerError): void {
    const worker = this.worker;
    if (worker) {
      worker.removeEventListener("message", this.onMessage);
      worker.removeEventListener("error", this.onError);
      worker.terminate();
    }
    this.worker = undefined;
    this.initializationGate = undefined;
    if (error) {
      for (const operation of this.pending.values()) {
        operation.detachAbort?.();
        operation.reject(error);
      }
    }
    this.pending.clear();
  }
}

function combineSignals(
  callerSignal: AbortSignal | undefined,
  effectSignal: AbortSignal,
): AbortSignal {
  return callerSignal
    ? AbortSignal.any([callerSignal, effectSignal])
    : effectSignal;
}

function asWorkerError(cause: unknown): TraceJVMWorkerError {
  if (
    cause instanceof TraceJVMAbortedError ||
    cause instanceof TraceJVMWorkerCrashedError ||
    cause instanceof TraceJVMWorkerReportedError ||
    cause instanceof TraceJVMWorkerTerminatedError
  ) {
    return cause;
  }
  return new TraceJVMWorkerReportedError(
    cause instanceof Error ? cause.message : String(cause),
  );
}

function serializeHostError(cause: unknown): {
  name: string;
  message: string;
  code?: string;
} {
  const error = cause as Partial<Error> & { code?: unknown };
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    message:
      typeof error?.message === "string" ? error.message : String(cause),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
  };
}

function postAsyncHostSuccess(
  worker: TraceJVMWorkerLike,
  id: number,
  value: unknown,
): void {
  try {
    worker.postMessage({
      id,
      type: "host-response-async",
      response: { ok: true, value },
    });
  } catch (cause) {
    postAsyncHostFailure(
      worker,
      id,
      new TypeError(
        `TraceJVM host response was not serializable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      ),
    );
  }
}

function postAsyncHostFailure(
  worker: TraceJVMWorkerLike,
  id: number,
  cause: unknown,
): void {
  worker.postMessage({
    id,
    type: "host-response-async",
    response: { ok: false, error: serializeHostError(cause) },
  });
}
