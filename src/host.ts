/**
 * Generic host operation envelope. TraceJVM defines service contracts
 * capability-by-capability; the transport itself does not import a product
 * kernel or assume a particular filesystem implementation.
 */
export interface TraceJVMHostRequest<
  Payload = unknown,
> {
  readonly service: string;
  readonly operation: string;
  readonly payload?: Payload;
}

/** Synchronous boundary used inside the TraceJVM execution Worker. */
export interface TraceJVMSynchronousHost {
  dispatchSync(request: TraceJVMHostRequest): unknown;
}

/** Non-blocking boundary used by natives that may suspend a Java thread. */
export interface TraceJVMAsynchronousHost {
  dispatch(request: TraceJVMHostRequest): Promise<unknown>;
}

/**
 * Asynchronous embedder boundary serviced outside the execution Worker.
 * Browser clients expose it to both the synchronous SharedArrayBuffer bridge
 * and the per-Java-thread asynchronous bridge.
 */
export interface TraceJVMWorkerHost {
  dispatch(request: TraceJVMHostRequest): Promise<unknown> | unknown;
}
