import type {
  TraceJVMCompileRequest,
  TraceJVMCompileResult,
  TraceJVMExecuteResult,
  TraceJVMOptions,
  TraceJVMRunRequest,
} from "./engine";
import type { TraceJVMCompilerOptions } from "./compiler";
import type { TraceJVMHostRequest } from "./host";
import type { TraceJVMHostChannel } from "./host-channel";

interface TraceJVMSerializedHostError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

type SerializableCompileRequest = Omit<
  TraceJVMCompileRequest,
  "signal" | "onStdout" | "onStderr"
>;
type SerializableRunRequest = Omit<
  TraceJVMRunRequest,
  "signal" | "onStdout" | "onStderr"
>;
export type TraceJVMWorkerRequest =
  | {
      id: number;
      type: "initialize";
      options: Omit<TraceJVMOptions, "host">;
      hostChannel?: TraceJVMHostChannel;
    }
  | { id: number; type: "run"; request: SerializableRunRequest }
  | {
      id: number;
      type: "initialize-compiler";
      options: TraceJVMCompilerOptions;
    }
  | {
      id: number;
      type: "compile";
      request: SerializableCompileRequest;
    }
  | { id: number; type: "cancel"; targetId: number }
  | {
      id: number;
      type: "host-response-async";
      response:
        | { ok: true; value: unknown }
        | { ok: false; error: TraceJVMSerializedHostError };
    }
  | { id: number; type: "dispose" };

export type TraceJVMWorkerResponse =
  | {
      id: number;
      type: "initialized";
      result: { initializeMs: number };
    }
  | { id: number; type: "run-result"; result: TraceJVMExecuteResult }
  | {
      id: number;
      type: "compiler-initialized";
      result: { initializeMs: number };
    }
  | {
      id: number;
      type: "compile-result";
      result: TraceJVMCompileResult;
    }
  | {
      id: number;
      type: "stream";
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      id: number;
      type: "host-call";
      request: TraceJVMHostRequest;
    }
  | {
      id: number;
      type: "host-call-async";
      request: TraceJVMHostRequest;
    }
  | { id: number; type: "disposed" }
  | { id: number; type: "error"; error: string };
