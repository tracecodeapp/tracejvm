export const TRACEJVM_RUNTIME_ARCHIVE_FORMAT: "tar+zstd-v1";

export interface TraceJVMRuntimeArchiveFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export function createTraceJVMRuntimeArchive(options: {
  sourceRoot: string;
  files: readonly TraceJVMRuntimeArchiveFile[];
  outputPath: string;
}): Promise<Readonly<{
  path: string;
  format: typeof TRACEJVM_RUNTIME_ARCHIVE_FORMAT;
  size: number;
  sha256: string;
  integrity: string;
}>>;

export function extractTraceJVMRuntimeArchive(options: {
  archivePath: string;
  destination: string;
  files: readonly TraceJVMRuntimeArchiveFile[];
}): Promise<string>;
