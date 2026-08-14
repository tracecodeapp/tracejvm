import * as Data from "effect/Data";

/**
 * Failures of the TraceJVM runtime itself.
 *
 * Java compilation failures and uncaught Java exceptions are deliberately not
 * represented here. They are ordinary execution outcomes carried by
 * TraceJVMCompileResult and TraceJVMExecuteResult.
 */
export class TraceJVMInitializationError extends Data.TaggedError(
  "TraceJVMInitializationError",
)<{
  readonly cause: unknown;
}> {
  constructor(cause: unknown) {
    super({ cause });
    this.message = `TraceJVM failed to initialize: ${describeCause(cause)}`;
  }
}

export class TraceJVMOperationError extends Data.TaggedError(
  "TraceJVMOperationError",
)<{
  readonly operation: "compile" | "run" | "execute";
  readonly cause: unknown;
}> {
  constructor(
    operation: "compile" | "run" | "execute",
    cause: unknown,
  ) {
    super({ operation, cause });
    this.message = `TraceJVM ${operation} infrastructure failed: ${describeCause(cause)}`;
  }
}

export class TraceJVMWorkerCrashedError extends Data.TaggedError(
  "TraceJVMWorkerCrashedError",
)<{
  readonly workerMessage: string | undefined;
  readonly filename: string | undefined;
  readonly lineno: number | undefined;
  readonly colno: number | undefined;
}> {
  constructor(args: {
    readonly workerMessage: string | undefined;
    readonly filename: string | undefined;
    readonly lineno: number | undefined;
    readonly colno: number | undefined;
  }) {
    super(args);
    this.message = args.workerMessage || "TraceJVM Worker crashed.";
  }
}

export class TraceJVMWorkerReportedError extends Data.TaggedError(
  "TraceJVMWorkerReportedError",
)<{
  readonly workerMessage: string;
}> {
  constructor(workerMessage: string) {
    super({ workerMessage });
    this.message = workerMessage;
  }
}

export class TraceJVMWorkerTerminatedError extends Data.TaggedError(
  "TraceJVMWorkerTerminatedError",
) {
  constructor(message = "TraceJVM Worker was terminated.") {
    super();
    this.message = message;
  }
}

export class TraceJVMAbortedError extends Data.TaggedError(
  "TraceJVMAbortedError",
) {
  constructor() {
    super();
    this.message = "TraceJVM operation was aborted.";
    this.name = "AbortError";
  }
}

export type TraceJVMEngineError =
  | TraceJVMInitializationError
  | TraceJVMOperationError;

export type TraceJVMWorkerError =
  | TraceJVMAbortedError
  | TraceJVMWorkerCrashedError
  | TraceJVMWorkerReportedError
  | TraceJVMWorkerTerminatedError;

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "unknown failure";
  }
}
