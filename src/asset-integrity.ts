export interface TraceJVMAssetIntegrity {
  readonly size: number;
  readonly sha256: string;
}

export type TraceJVMAssetIntegrityMap = Readonly<
  Record<string, TraceJVMAssetIntegrity>
>;

export interface TraceJVMReleaseFileIntegrity extends TraceJVMAssetIntegrity {
  readonly path: string;
}

export function traceJVMAssetUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function createTraceJVMAssetIntegrityMap(
  baseUrl: string,
  files: readonly TraceJVMReleaseFileIntegrity[],
): TraceJVMAssetIntegrityMap {
  const result: Record<string, TraceJVMAssetIntegrity> = Object.create(null);
  for (const file of files) {
    if (
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`Invalid TraceJVM release asset path: ${file.path}`);
    }
    const url = traceJVMAssetUrl(baseUrl, file.path);
    if (result[url]) {
      throw new Error(`Duplicate TraceJVM release asset URL: ${url}`);
    }
    result[url] = { size: file.size, sha256: file.sha256 };
  }
  return Object.freeze(result);
}

export function traceJVMAssetIntegrity(
  assets: TraceJVMAssetIntegrityMap,
  url: string,
): TraceJVMAssetIntegrity {
  const integrity = assets[url];
  if (!integrity) {
    throw new Error(`TraceJVM asset has no pinned integrity metadata: ${url}`);
  }
  if (!Number.isSafeInteger(integrity.size) || integrity.size < 0) {
    throw new Error(`TraceJVM asset has an invalid pinned size: ${url}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(integrity.sha256)) {
    throw new Error(`TraceJVM asset has an invalid pinned SHA-256: ${url}`);
  }
  return integrity;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export async function fetchVerifiedTraceJVMAsset(
  url: string,
  assets: TraceJVMAssetIntegrityMap,
  init?: RequestInit,
): Promise<Uint8Array> {
  const expected = traceJVMAssetIntegrity(assets, url);
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Unable to load TraceJVM asset ${url}: HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== expected.size) {
    throw new Error(
      `TraceJVM asset size mismatch for ${url}: expected ${expected.size}, got ${bytes.byteLength}.`,
    );
  }
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("TraceJVM asset verification requires Web Crypto SHA-256.");
  }
  const digest = hex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
  if (digest !== expected.sha256) {
    throw new Error(
      `TraceJVM asset SHA-256 mismatch for ${url}: expected ${expected.sha256}, got ${digest}.`,
    );
  }
  return bytes;
}

export async function importVerifiedTraceJVMModule<T>(
  url: string,
  assets: TraceJVMAssetIntegrityMap,
): Promise<T> {
  const bytes = await fetchVerifiedTraceJVMAsset(url, assets);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  return import(/* @vite-ignore */ moduleUrl) as Promise<T>;
}
