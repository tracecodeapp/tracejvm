import type {
  TraceJVMHostRequest,
  TraceJVMSynchronousHost,
} from "./host";

const STATE_INDEX = 0;
const LENGTH_INDEX = 1;
const HEADER_BYTES = 8;

const STATE_IDLE = 0;
const STATE_RESPONSE = 1;
const STATE_FAILURE = 2;
const STATE_CLOSED = 3;
const STATE_PENDING = 4;

const DEFAULT_BYTE_CAPACITY = 1 << 20;
const MINIMUM_BYTE_CAPACITY = 256;

export interface TraceJVMHostChannel {
  readonly buffer: SharedArrayBuffer;
  readonly byteCapacity: number;
}

interface EncodedBytes {
  readonly __traceJVMType: "bytes";
  readonly base64: string;
}

interface EncodedFailure {
  readonly name: string;
  readonly message: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encode(value: unknown): Uint8Array {
  const json = JSON.stringify({ value }, (_key, candidate: unknown) => {
    if (candidate instanceof Uint8Array) {
      return {
        __traceJVMType: "bytes",
        base64: bytesToBase64(candidate),
      } satisfies EncodedBytes;
    }
    return candidate;
  });
  return new TextEncoder().encode(json);
}

function decode(bytes: Uint8Array): unknown {
  const envelope = JSON.parse(
    new TextDecoder().decode(bytes),
    (_key, candidate: unknown) => {
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as Partial<EncodedBytes>).__traceJVMType === "bytes" &&
        typeof (candidate as Partial<EncodedBytes>).base64 === "string"
      ) {
        return bytesFromBase64((candidate as EncodedBytes).base64);
      }
      return candidate;
    },
  ) as { value?: unknown };
  return envelope.value;
}

function channelViews(channel: TraceJVMHostChannel): {
  header: Int32Array;
  payload: Uint8Array;
} {
  if (
    channel.byteCapacity <= 0 ||
    channel.buffer.byteLength !== HEADER_BYTES + channel.byteCapacity
  ) {
    throw new Error("Invalid TraceJVM host channel.");
  }
  return {
    header: new Int32Array(channel.buffer, 0, 2),
    payload: new Uint8Array(channel.buffer, HEADER_BYTES),
  };
}

export function makeTraceJVMHostChannel(
  byteCapacity = DEFAULT_BYTE_CAPACITY,
): TraceJVMHostChannel {
  if (
    !Number.isSafeInteger(byteCapacity) ||
    byteCapacity < MINIMUM_BYTE_CAPACITY
  ) {
    throw new RangeError(
      `TraceJVM host channel capacity must be at least ${MINIMUM_BYTE_CAPACITY} bytes.`,
    );
  }
  return Object.freeze({
    buffer: new SharedArrayBuffer(HEADER_BYTES + byteCapacity),
    byteCapacity,
  });
}

function write(
  channel: TraceJVMHostChannel,
  state: typeof STATE_RESPONSE | typeof STATE_FAILURE,
  value: unknown,
): void {
  const { header, payload } = channelViews(channel);
  if (Atomics.load(header, STATE_INDEX) !== STATE_PENDING) return;
  let bytes: Uint8Array;
  let finalState = state;
  try {
    bytes = encode(value);
  } catch (cause) {
    finalState = STATE_FAILURE;
    bytes = encode({
      name: cause instanceof Error ? cause.name : "TypeError",
      message:
        cause instanceof Error
          ? `TraceJVM host response was not serializable: ${cause.message}`
          : "TraceJVM host response was not serializable.",
    } satisfies EncodedFailure);
  }
  if (bytes.length > payload.length) {
    finalState = STATE_FAILURE;
    bytes = encode({
      name: "RangeError",
      message:
        `TraceJVM host response exceeded ${channel.byteCapacity} bytes.`,
    } satisfies EncodedFailure);
  }
  payload.fill(0, 0, Math.min(Atomics.load(header, LENGTH_INDEX), payload.length));
  payload.set(bytes);
  Atomics.store(header, LENGTH_INDEX, bytes.length);
  if (
    Atomics.compareExchange(
      header,
      STATE_INDEX,
      STATE_PENDING,
      finalState,
    ) === STATE_PENDING
  ) {
    Atomics.notify(header, STATE_INDEX);
  }
}

export function respondToTraceJVMHostCall(
  channel: TraceJVMHostChannel,
  value: unknown,
): void {
  write(channel, STATE_RESPONSE, value);
}

export function failTraceJVMHostCall(
  channel: TraceJVMHostChannel,
  cause: unknown,
): void {
  write(channel, STATE_FAILURE, {
    name: cause instanceof Error ? cause.name : "Error",
    message: cause instanceof Error ? cause.message : String(cause),
  } satisfies EncodedFailure);
}

export function closeTraceJVMHostChannel(
  channel: TraceJVMHostChannel,
): void {
  const { header } = channelViews(channel);
  Atomics.store(header, STATE_INDEX, STATE_CLOSED);
  Atomics.notify(header, STATE_INDEX);
}

export function makeTraceJVMSynchronousHost(
  channel: TraceJVMHostChannel,
  notify: (request: TraceJVMHostRequest) => void,
): TraceJVMSynchronousHost {
  const { header, payload } = channelViews(channel);
  return {
    dispatchSync(request) {
      const state = Atomics.compareExchange(
        header,
        STATE_INDEX,
        STATE_IDLE,
        STATE_PENDING,
      );
      if (state === STATE_CLOSED) {
        throw new Error("TraceJVM host channel is closed.");
      }
      if (state !== STATE_IDLE) {
        throw new Error("Concurrent TraceJVM host calls are not supported.");
      }
      Atomics.store(header, LENGTH_INDEX, 0);
      try {
        notify(request);
      } catch (cause) {
        Atomics.compareExchange(
          header,
          STATE_INDEX,
          STATE_PENDING,
          STATE_IDLE,
        );
        throw cause;
      }
      while (Atomics.load(header, STATE_INDEX) === STATE_PENDING) {
        Atomics.wait(header, STATE_INDEX, STATE_PENDING);
      }
      const completedState = Atomics.load(header, STATE_INDEX);
      const length = Atomics.load(header, LENGTH_INDEX);
      if (completedState === STATE_CLOSED) {
        throw new Error("TraceJVM host channel closed during a host call.");
      }
      if (length < 0 || length > payload.length) {
        Atomics.compareExchange(
          header,
          STATE_INDEX,
          completedState,
          STATE_IDLE,
        );
        throw new Error("TraceJVM host returned an invalid response length.");
      }
      let value: unknown;
      try {
        value = decode(payload.slice(0, length));
      } finally {
        Atomics.compareExchange(
          header,
          STATE_INDEX,
          completedState,
          STATE_IDLE,
        );
      }
      if (completedState === STATE_FAILURE) {
        const failure = value as Partial<EncodedFailure>;
        const error = new Error(
          typeof failure.message === "string"
            ? failure.message
            : "TraceJVM host call failed.",
        );
        if (typeof failure.name === "string") error.name = failure.name;
        throw error;
      }
      if (completedState !== STATE_RESPONSE) {
        throw new Error("TraceJVM host returned an invalid channel state.");
      }
      return value;
    },
  };
}
