declare module "@b-jvm/bjvm2" {
  export interface RuntimeSystemOptions {
      runtimeUrl: string;
      wasmLocation?: string;
      wasmBinary?: Uint8Array;
      loadRuntimeFile?: (file: string) => Promise<Uint8Array>;
    additionalRuntimeFiles: string[];
    loadPlatformModuleImage?: boolean;
    stdout?: (bytes: Uint8Array) => void | null;
    stderr?: (bytes: Uint8Array) => void | null;
    hostDispatchSync?: (request: unknown) => unknown;
    hostDispatchAsync?: (request: unknown) => Promise<unknown>;
    hostStandardDescriptors?: boolean;
  }

  export interface RuntimeVM {
    setPreemptionFrequencyUs(microseconds: number): void;
    loadClass(name: never): unknown;
    isDestroyed(): boolean;
    dispose(): void;
  }

  export interface RuntimeSystem {
    FS: {
      chdir(path: string): void;
      lstat(path: string): { mode: number };
      mkdir(path: string): void;
      readFile(path: string): Uint8Array;
      readdir(path: string): string[];
      rmdir(path: string): void;
      unlink(path: string): void;
      writeFile(path: string, bytes: Uint8Array): void;
    };
    makeVM(options: {
      classpath: string;
      heapSize: number;
      experimentalHotAot?: boolean;
      stdout?: (bytes: Uint8Array) => void | null;
      stderr?: (bytes: Uint8Array) => void | null;
      hostDispatchSync?: (request: unknown) => unknown;
      hostDispatchAsync?: (request: unknown) => Promise<unknown>;
      hostStandardDescriptors?: boolean;
      workingDirectory?: string;
    }): RuntimeVM;
  }

  export function makeRuntimeSystem(options: RuntimeSystemOptions): Promise<RuntimeSystem>;
}
