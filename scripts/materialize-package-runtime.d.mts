export interface TraceJVMPackageRuntimeManifest {
  readonly schema: "tracejvm-package-runtime-v1";
  readonly releaseId: string;
  readonly archive: Readonly<{
    path: string;
    format: "tar+zstd-v1";
    size: number;
    sha256: string;
    integrity: string;
  }>;
  readonly files: readonly Readonly<{
    path: string;
    size: number;
    sha256: string;
  }>[];
}

export function materializeTraceJVMPackageRuntime(options?: {
  root?: string;
}): Promise<TraceJVMPackageRuntimeManifest>;
