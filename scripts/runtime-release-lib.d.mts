export const TRACEJVM_RUNTIME_RELEASE_SCHEMA: "tracejvm-runtime-release-v2";
export const TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR: "release.json";
export const TRACEJVM_RUNTIME_CACHE_CONTROL: string;
export const TRACEJVM_RUNTIME_RESPONSE_POLICY: Readonly<{
  accessControlAllowOrigin: "*";
  crossOriginResourcePolicy: "cross-origin";
  xContentTypeOptions: "nosniff";
  worker: Readonly<{
    crossOriginEmbedderPolicy: "require-corp";
    contentSecurityPolicy: string;
  }>;
}>;

export interface TraceJVMRuntimeReleaseFile {
  path: string;
  size: number;
  sha256: string;
  integrity: string;
  contentType: string;
  cacheControl: string;
}

export interface TraceJVMRuntimeReleaseDescriptor {
  schema: typeof TRACEJVM_RUNTIME_RELEASE_SCHEMA;
  package: {
    name: string;
    version: string;
  };
  runtime: {
    profiles: Record<string, unknown>;
    [key: string]: unknown;
  };
  contentHash: string;
  relativePrefix: string;
  responsePolicy: typeof TRACEJVM_RUNTIME_RESPONSE_POLICY;
  entrypoints: {
    browserClient: string;
    browserWorker: string;
    wasm: string;
    profiles: Record<string, string>;
  };
  files: TraceJVMRuntimeReleaseFile[];
}

export interface PreparedTraceJVMRuntimeRelease {
  descriptor: TraceJVMRuntimeReleaseDescriptor;
  descriptorPath: string;
  descriptorSha256: string;
  version: string;
  contentHash: string;
  relativePrefix: string;
  outputDirectory: string;
  assetCount: number;
  payloadBytes: number;
}

export interface TraceJVMRuntimeReleaseSource {
  source: string;
  target: string;
  exclude?: string[];
}

export function contentTypeForTraceJVMAsset(relativePath: string): string;

export function normalizeTraceJVMReleasePath(
  value: string,
  label?: string,
): string;

export function prepareTraceJVMRuntimeRelease(options?: {
  root?: string;
  outputRoot?: string;
  sourceTrees?: TraceJVMRuntimeReleaseSource[];
  sourceFiles?: TraceJVMRuntimeReleaseSource[];
}): PreparedTraceJVMRuntimeRelease;

export function readTraceJVMRuntimeRelease(directory: string): {
  descriptor: TraceJVMRuntimeReleaseDescriptor;
  descriptorPath: string;
};

export function verifyTraceJVMRuntimeRelease(directory: string): {
  descriptor: TraceJVMRuntimeReleaseDescriptor;
  descriptorPath: string;
  descriptorSha256: string;
  descriptorSize: number;
  payloadBytes: number;
};
