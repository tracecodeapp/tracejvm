export interface TraceJVMResourceLimits {
  /** Maximum file and string payload entries per request. */
  maxInputFiles: number;
  /** Maximum aggregate request payload before Worker transfer or VM writes. */
  maxInputBytes: number;
  /** Maximum size of one source, class, JAR, or process file. */
  maxFileBytes: number;
  /** Maximum combined stdout and stderr retained for one execution. */
  maxOutputBytes: number;
}

export const TRACEJVM_DEFAULT_RESOURCE_LIMITS: TraceJVMResourceLimits =
  Object.freeze({
    maxInputFiles: 4_096,
    maxInputBytes: 128 * 1024 * 1024,
    maxFileBytes: 64 * 1024 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
  });

export function resolveTraceJVMResourceLimits(
  configured?: Partial<TraceJVMResourceLimits>,
): TraceJVMResourceLimits {
  const limits = {
    ...TRACEJVM_DEFAULT_RESOURCE_LIMITS,
    ...configured,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`TraceJVM ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

interface ResourceInput {
  readonly label: string;
  readonly bytes: number;
}

function assertResourceInputs(
  inputs: readonly ResourceInput[],
  configured?: Partial<TraceJVMResourceLimits>,
): void {
  const limits = resolveTraceJVMResourceLimits(configured);
  if (inputs.length > limits.maxInputFiles) {
    throw new RangeError(
      `TraceJVM request has ${inputs.length} payload entries; limit is ` +
        `${limits.maxInputFiles}.`,
    );
  }
  let total = 0;
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
      throw new RangeError(`TraceJVM ${input.label} has an invalid size.`);
    }
    if (input.bytes > limits.maxFileBytes) {
      throw new RangeError(
        `TraceJVM ${input.label} is ${input.bytes} bytes; per-file limit is ` +
          `${limits.maxFileBytes}.`,
      );
    }
    total += input.bytes;
    if (!Number.isSafeInteger(total) || total > limits.maxInputBytes) {
      throw new RangeError(
        `TraceJVM request payload exceeds ${limits.maxInputBytes} bytes.`,
      );
    }
  }
}

export function validateTraceJVMCompileResources(
  request: {
    readonly sources: readonly { path: string; content: string }[];
    readonly classpath?: readonly { path: string; content: Uint8Array }[];
  },
  configured?: Partial<TraceJVMResourceLimits>,
): void {
  assertResourceInputs([
    ...request.sources.map((source) => ({
      label: `source ${JSON.stringify(source.path)}`,
      bytes: utf8ByteLength(source.content),
    })),
    ...(request.classpath ?? []).map((file) => ({
      label: `classpath file ${JSON.stringify(file.path)}`,
      bytes: file.content.byteLength,
    })),
  ], configured);
}

export function validateTraceJVMRunResources(
  request: {
    readonly program: {
      readonly files: readonly { path: string; content: Uint8Array }[];
    };
    readonly classpath?: readonly { path: string; content: Uint8Array }[];
    readonly processFiles?: readonly { path: string; content: Uint8Array }[];
    readonly mainClass: string;
    readonly args?: readonly string[];
    readonly systemProperties?: Readonly<Record<string, string>>;
  },
  configured?: Partial<TraceJVMResourceLimits>,
): void {
  assertResourceInputs([
    ...request.program.files.map((file) => ({
      label: `program file ${JSON.stringify(file.path)}`,
      bytes: file.content.byteLength,
    })),
    ...(request.classpath ?? []).map((file) => ({
      label: `classpath file ${JSON.stringify(file.path)}`,
      bytes: file.content.byteLength,
    })),
    ...(request.processFiles ?? []).map((file) => ({
      label: `process file ${JSON.stringify(file.path)}`,
      bytes: file.content.byteLength,
    })),
    {
      label: "main class name",
      bytes: utf8ByteLength(request.mainClass),
    },
    ...(request.args ?? []).map((argument, index) => ({
      label: `argument ${index}`,
      bytes: utf8ByteLength(argument),
    })),
    ...Object.entries(request.systemProperties ?? {}).map(([key, value]) => ({
      label: `system property ${JSON.stringify(key)}`,
      bytes: utf8ByteLength(key) + utf8ByteLength(value),
    })),
  ], configured);
}

export function validateTraceJVMGeneratedResources(
  files: readonly { path: string; content: Uint8Array }[],
  configured?: Partial<TraceJVMResourceLimits>,
): void {
  assertResourceInputs(files.map((file) => ({
    label: `compiler output ${JSON.stringify(file.path)}`,
    bytes: file.content.byteLength,
  })), configured);
}

export class TraceJVMOutputBudget {
  private usedBytes = 0;

  constructor(private readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new RangeError(
        "TraceJVM output limit must be a positive safe integer.",
      );
    }
  }

  consume(chunk: string): void {
    const next = this.usedBytes + utf8ByteLength(chunk);
    if (!Number.isSafeInteger(next) || next > this.maximumBytes) {
      throw new RangeError(
        `TraceJVM output exceeds ${this.maximumBytes} bytes.`,
      );
    }
    this.usedBytes = next;
  }
}
