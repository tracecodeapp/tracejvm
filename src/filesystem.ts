export interface TraceJVMFileSystem {
  lstat(path: string): { mode: number };
  readdir(path: string): string[];
  rmdir(path: string): void;
  unlink(path: string): void;
}

const FILE_TYPE_MASK = 0xf000;
const DIRECTORY_TYPE = 0x4000;
const SYMBOLIC_LINK_TYPE = 0xa000;

/** Remove a scratch tree without ever traversing a symbolic link. */
export function removeTreeNoFollow(
  fs: TraceJVMFileSystem,
  path: string,
): void {
  let mode: number;
  try {
    mode = fs.lstat(path).mode;
  } catch {
    return;
  }

  const type = mode & FILE_TYPE_MASK;
  if (type === SYMBOLIC_LINK_TYPE || type !== DIRECTORY_TYPE) {
    try {
      fs.unlink(path);
    } catch {
      // Best-effort scratch cleanup.
    }
    return;
  }

  let entries: string[];
  try {
    entries = fs.readdir(path);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "." || entry === "..") continue;
    removeTreeNoFollow(fs, `${path}/${entry}`);
  }
  try {
    fs.rmdir(path);
  } catch {
    // Best-effort scratch cleanup.
  }
}
