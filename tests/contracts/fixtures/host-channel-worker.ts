import { parentPort, workerData } from "node:worker_threads";

// The contract suite executes this Worker through tsx; the explicit extension
// is required because Node resolves Worker entry modules independently.
// @ts-expect-error TypeScript disallows .ts imports without emit-specific flags.
import { makeTraceJVMSynchronousHost, type TraceJVMHostChannel } from "../../../src/host-channel.ts";
import type { TraceJVMHostRequest } from "../../../src/host.ts";

if (!parentPort) throw new Error("Host-channel fixture requires a parent port.");

const port = parentPort;
const host = makeTraceJVMSynchronousHost(
  workerData as TraceJVMHostChannel,
  (request) => port.postMessage({ type: "request", request }),
);

port.on(
  "message",
  (message: { type: "dispatch"; request: TraceJVMHostRequest }) => {
    if (message.type !== "dispatch") return;
    try {
      port.postMessage({
        type: "result",
        value: host.dispatchSync(message.request),
      });
    } catch (cause) {
      port.postMessage({
        type: "failure",
        name: cause instanceof Error ? cause.name : "Error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  },
);
