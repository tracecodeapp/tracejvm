import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  TraceJVMEngine,
  type TraceJVM,
  type TraceJVMOptions,
} from "./engine";
import {
  TraceJVMWorkerClient,
  type TraceJVMWorkerClientOptions,
} from "./worker-client";

/**
 * Effect service for an in-process TraceJVM engine.
 *
 * The scoped layer is the preferred construction boundary. It makes teardown
 * structural, including when a downstream layer fails to build or a scope is
 * interrupted.
 */
export class TraceJVMEngineService extends Context.Tag(
  "@tracecode/tracejvm/Engine",
)<TraceJVMEngineService, TraceJVM>() {}

export function makeTraceJVMEngineLayer(
  options: TraceJVMOptions,
): Layer.Layer<TraceJVMEngineService> {
  return Layer.scoped(
    TraceJVMEngineService,
    Effect.acquireRelease(
      Effect.sync(() => new TraceJVMEngine(options)),
      (engine) => Effect.sync(() => engine.dispose()),
    ),
  );
}

/**
 * Effect service for the Worker-isolated TraceJVM client.
 *
 * Worker termination is intentionally the finalizer. The current VM cannot
 * completely dispose itself from inside the Worker, so waiting for an
 * application-level dispose reply is not a safe scope-unwind primitive.
 */
export class TraceJVMWorkerService extends Context.Tag(
  "@tracecode/tracejvm/Worker",
)<TraceJVMWorkerService, TraceJVMWorkerClient>() {}

export function makeTraceJVMWorkerLayer(
  options: TraceJVMWorkerClientOptions,
): Layer.Layer<TraceJVMWorkerService> {
  return Layer.scoped(
    TraceJVMWorkerService,
    Effect.acquireRelease(
      Effect.sync(() => new TraceJVMWorkerClient(options)),
      (client) => Effect.sync(() => client.terminate()),
    ),
  );
}
