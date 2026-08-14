export function validateRelativePath(path: string, label: string): void {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`Invalid ${label} path: ${JSON.stringify(path)}`);
  }
}

export function validateProcessFilePath(path: string): void {
  if (
    typeof path !== "string" ||
    path.length <= 1 ||
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(`Invalid Java process file path: ${JSON.stringify(path)}`);
  }
  const segments = path.slice(1).split("/");
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".."
  )) {
    throw new Error(`Invalid Java process file path: ${JSON.stringify(path)}`);
  }
  const first = segments[0];
  if (first === "tracejvm" || first === "tracekernel-api") {
    throw new Error(`Invalid Java process file path: ${JSON.stringify(path)}`);
  }
}
