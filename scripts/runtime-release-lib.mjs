import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const TRACEJVM_RUNTIME_RELEASE_SCHEMA = "tracejvm-runtime-release-v2";
export const TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR = "release.json";
export const TRACEJVM_RUNTIME_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
export const TRACEJVM_RUNTIME_RESPONSE_POLICY = Object.freeze({
  accessControlAllowOrigin: "*",
  crossOriginResourcePolicy: "cross-origin",
  xContentTypeOptions: "nosniff",
  worker: Object.freeze({
    crossOriginEmbedderPolicy: "require-corp",
    contentSecurityPolicy:
      "default-src 'none'; script-src 'self' data:; connect-src 'self'",
  }),
});

export function contentTypeForTraceJVMAsset(relativePath) {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (lower.endsWith(".jar")) return "application/java-archive";
  if (lower.endsWith(".class")) return "application/java-vm";
  if (
    lower.endsWith(".md") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".properties") ||
    lower.endsWith(".policy") ||
    lower.endsWith(".security") ||
    lower.endsWith(".map")
  ) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

export function normalizeTraceJVMReleasePath(value, label = "release path") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    isAbsolute(value)
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return segments.join("/");
}

function listFiles(directory, base = directory, excludedPaths = []) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      const relativePath = relative(base, absolute).split(sep).join("/");
      if (excludedPaths.some((excluded) =>
        relativePath === excluded || relativePath.startsWith(`${excluded}/`)
      )) {
        return [];
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Runtime releases must not contain symlinks: ${absolute}`);
      }
      return entry.isDirectory()
        ? listFiles(absolute, base, excludedPaths)
        : [{
            absolute,
            relative: relativePath,
          }];
    })
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function integrityFromHex(hex) {
  return `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

export function prepareTraceJVMRuntimeRelease(options = {}) {
  const root = options.root ?? join(import.meta.dirname, "..");
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const runtime = JSON.parse(
    readFileSync(join(root, "runtime", "manifest.json"), "utf8"),
  );
  const compilerSource = JSON.parse(
    readFileSync(
      join(root, "compiler", "teavm-javac", "manifest.json"),
      "utf8",
    ),
  );
  const temurinLegalRoot = join(
    root,
    ".cache",
    "runtime-legal",
    `temurin-${runtime.javaVersion.replace("+", "_")}`,
  );
  const compilerSourceRoot = join(
    root,
    ".cache",
    "teavm-javac",
    `source-${compilerSource.upstream.commit}-overlay-${compilerSource.overlay.version}`,
    "javac",
    "build",
    "jdk",
    `${compilerSource.jdk.archiveRoot}-${compilerSource.jdk.revision}`,
  );
  const sourceCache = join(root, ".cache", "runtime-sources");
  const sourceTrees = options.sourceTrees ?? [
    {
      source: join(root, "runtime", "assets"),
      target: "",
    },
    {
      source: join(root, ".cache", "teavm-javac", "artifacts"),
      target: "compiler",
    },
    {
      source: join(temurinLegalRoot, "legal"),
      target: `legal/TEMURIN-${runtime.javaVersion}`,
    },
    {
      source: join(root, "compiler", "teavm-javac", "patches"),
      target: "source/tracejvm/compiler/teavm-javac/patches",
    },
    {
      source: join(root, "runtime", "api"),
      target: "source/tracejvm/runtime/api",
    },
    {
      source: join(root, "runtime", "bridge"),
      target: "source/tracejvm/runtime/bridge",
    },
    {
      source: join(root, "src"),
      target: "source/tracejvm/src",
    },
    ...["cmake", "codegen", "js", "natives", "vendor", "vm"].map(
      (directory) => ({
        source: join(root, "engine", "bjvm", directory),
        target: `source/tracejvm/engine/bjvm/${directory}`,
        ...(directory === "js" ? { exclude: ["pages/dist"] } : {}),
      }),
    ),
  ];
  const sourceFiles = options.sourceFiles ?? [
    {
      source: join(root, "dist", "browser-client.js"),
      target: "browser-client.js",
    },
    {
      source: join(root, "dist", "browser-worker.js"),
      target: "browser-worker.js",
    },
    {
      source: join(root, "LICENSE"),
      target: "legal/TRACEJVM-AGPL-3.0.txt",
    },
    {
      source: join(root, "THIRD_PARTY_NOTICES.md"),
      target: "legal/THIRD_PARTY_NOTICES.md",
    },
    {
      source: join(root, "engine", "bjvm", "LICENSE"),
      target: "legal/B-JVM-MIT.txt",
    },
    {
      source: join(root, "compiler", "teavm-javac", "LICENSE"),
      target: "legal/TEAVM-JAVAC-APACHE-2.0.txt",
    },
    {
      source: join(root, "compiler", "teavm-javac", "NOTICE"),
      target: "legal/TEAVM-JAVAC-NOTICE.txt",
    },
    {
      source: join(root, "legal", "CORRESPONDING_SOURCE.md"),
      target: "legal/CORRESPONDING_SOURCE.md",
    },
    {
      source: join(temurinLegalRoot, "NOTICE"),
      target: `legal/TEMURIN-${runtime.javaVersion}-NOTICE.txt`,
    },
    {
      source: join(compilerSourceRoot, "LICENSE"),
      target: "legal/OPENJDK-COMPILER-GPL-2.0-WITH-CLASSPATH-EXCEPTION.txt",
    },
    {
      source: join(compilerSourceRoot, "ASSEMBLY_EXCEPTION"),
      target: "legal/OPENJDK-COMPILER-ASSEMBLY-EXCEPTION.txt",
    },
    {
      source: join(compilerSourceRoot, "ADDITIONAL_LICENSE_INFO"),
      target: "legal/OPENJDK-COMPILER-ADDITIONAL-LICENSE-INFO.txt",
    },
    {
      source: join(
        sourceCache,
        `adoptium-jdk23u-${runtime.source.revision}.tar.gz`,
      ),
      target: `source/adoptium-jdk23u-${runtime.source.revision}.tar.gz`,
    },
    {
      source: join(
        sourceCache,
        `openjdk-jdk23u-${compilerSource.jdk.revision}.zip`,
      ),
      target: `source/openjdk-jdk23u-${compilerSource.jdk.revision}.zip`,
    },
    {
      source: join(
        sourceCache,
        `teavm-javac-${compilerSource.upstream.commit}.tar.gz`,
      ),
      target: `source/teavm-javac-${compilerSource.upstream.commit}.tar.gz`,
    },
    {
      source: join(root, "runtime", "manifest.json"),
      target: "source/tracejvm/runtime/manifest.json",
    },
    {
      source: join(root, "compiler", "teavm-javac", "manifest.json"),
      target: "source/tracejvm/compiler/teavm-javac/manifest.json",
    },
    {
      source: join(root, "scripts", "build-runtime.sh"),
      target: "source/tracejvm/scripts/build-runtime.sh",
    },
    {
      source: join(root, "scripts", "build-teavm-javac.sh"),
      target: "source/tracejvm/scripts/build-teavm-javac.sh",
    },
    {
      source: join(root, "scripts", "bootstrap-toolchain.mjs"),
      target: "source/tracejvm/scripts/bootstrap-toolchain.mjs",
    },
    {
      source: join(root, "scripts", "java", "GenerateHotAot.java"),
      target: "source/tracejvm/scripts/java/GenerateHotAot.java",
    },
    {
      source: join(root, "package.json"),
      target: "source/tracejvm/package.json",
    },
    {
      source: join(root, "pnpm-lock.yaml"),
      target: "source/tracejvm/pnpm-lock.yaml",
    },
    {
      source: join(root, "tsconfig.json"),
      target: "source/tracejvm/tsconfig.json",
    },
    {
      source: join(root, "engine", "bjvm", "CMakeLists.txt"),
      target: "source/tracejvm/engine/bjvm/CMakeLists.txt",
    },
    {
      source: join(root, "engine", "bjvm", "CMakePresets.json"),
      target: "source/tracejvm/engine/bjvm/CMakePresets.json",
    },
  ];

  const declaredSourceArchives = [
    {
      path: join(
        sourceCache,
        `adoptium-jdk23u-${runtime.source.revision}.tar.gz`,
      ),
      sha256: runtime.source.archiveSha256,
      label: "Temurin/OpenJDK runtime source",
    },
    {
      path: join(
        sourceCache,
        `openjdk-jdk23u-${compilerSource.jdk.revision}.zip`,
      ),
      sha256: compilerSource.jdk.archiveSha256,
      label: "OpenJDK compiler source",
    },
    {
      path: join(
        sourceCache,
        `teavm-javac-${compilerSource.upstream.commit}.tar.gz`,
      ),
      sha256: compilerSource.upstream.archiveSha256,
      label: "TeaVM-javac source",
    },
  ];

  for (const file of sourceFiles) {
    if (!existsSync(file.source) || !statSync(file.source).isFile()) {
      throw new Error(`Missing TraceJVM release file: ${file.source}`);
    }
  }
  for (const source of declaredSourceArchives) {
    const actual = sha256(readFileSync(source.path));
    if (actual !== source.sha256) {
      throw new Error(
        `${source.label} checksum mismatch: expected ${source.sha256}, got ${actual}`,
      );
    }
  }
  for (const tree of sourceTrees) {
    if (!existsSync(tree.source) || !statSync(tree.source).isDirectory()) {
      throw new Error(
        `Missing TraceJVM runtime tree: ${tree.source}. Run pnpm build:runtime first.`,
      );
    }
  }

  const files = [
    ...sourceFiles.map((file) => ({
      absolute: file.source,
      relative: file.target,
    })),
    ...sourceTrees.flatMap((tree) =>
      listFiles(tree.source, tree.source, tree.exclude ?? []).map((file) => ({
        absolute: file.absolute,
        relative: tree.target
          ? `${tree.target}/${file.relative}`
          : file.relative,
      })),
    ),
  ].sort((left, right) => left.relative.localeCompare(right.relative));

  const seen = new Set();
  const treeHash = createHash("sha256");
  const releaseFiles = files.map((file) => {
    const relativePath = normalizeTraceJVMReleasePath(file.relative);
    if (seen.has(relativePath)) {
      throw new Error(`Duplicate TraceJVM release path: ${relativePath}`);
    }
    if (relativePath === TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR) {
      throw new Error(
        `${TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR} is reserved for the release descriptor.`,
      );
    }
    seen.add(relativePath);
    const content = readFileSync(file.absolute);
    const fileSha256 = sha256(content);
    treeHash.update(relativePath);
    treeHash.update("\0");
    treeHash.update(content);
    treeHash.update("\0");
    return {
      ...file,
      relative: relativePath,
      size: content.byteLength,
      sha256: fileSha256,
      integrity: integrityFromHex(fileSha256),
      contentType: contentTypeForTraceJVMAsset(file.relative),
      cacheControl: TRACEJVM_RUNTIME_CACHE_CONTROL,
    };
  });

  const contentHash = treeHash.digest("hex");
  const relativePrefix = `tracejvm/${packageJson.version}/${contentHash}`;
  const outputRoot =
    options.outputRoot ?? join(root, ".cache", "runtime-release");
  const outputDirectory = join(
    outputRoot,
    packageJson.version,
    contentHash,
  );
  rmSync(outputDirectory, { recursive: true, force: true });
  for (const file of releaseFiles) {
    const target = join(outputDirectory, ...file.relative.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file.absolute, target);
  }

  const descriptor = {
    schema: TRACEJVM_RUNTIME_RELEASE_SCHEMA,
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    runtime,
    contentHash,
    relativePrefix,
    responsePolicy: TRACEJVM_RUNTIME_RESPONSE_POLICY,
    entrypoints: {
      browserClient: "browser-client.js",
      browserWorker: "browser-worker.js",
      wasm: "bjvm_main.wasm",
      compiler: "compiler",
      profiles: Object.fromEntries(
        Object.keys(runtime.profiles)
          .filter((profile) => profile !== "compiler")
          .map((profile) => [profile, `profiles/${profile}`]),
      ),
    },
    files: releaseFiles.map((file) => ({
      path: file.relative,
      size: file.size,
      sha256: file.sha256,
      integrity: file.integrity,
      contentType: file.contentType,
      cacheControl: file.cacheControl,
    })),
  };
  const descriptorContents = `${JSON.stringify(descriptor, null, 2)}\n`;
  const descriptorPath = join(
    outputDirectory,
    TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
  );
  writeFileSync(descriptorPath, descriptorContents);

  return {
    descriptor,
    descriptorPath,
    descriptorSha256: sha256(descriptorContents),
    version: packageJson.version,
    contentHash,
    relativePrefix,
    outputDirectory,
    assetCount: releaseFiles.length + 1,
    payloadBytes: releaseFiles.reduce((sum, file) => sum + file.size, 0),
  };
}

export function readTraceJVMRuntimeRelease(directory) {
  const descriptorPath = join(
    directory,
    TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
  );
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  if (descriptor.schema !== TRACEJVM_RUNTIME_RELEASE_SCHEMA) {
    throw new Error(
      `Unsupported TraceJVM runtime release schema: ${descriptor.schema}`,
    );
  }
  if (
    descriptor.package?.name !== "@tracecode/tracejvm" ||
    typeof descriptor.package.version !== "string" ||
    descriptor.package.version.length === 0
  ) {
    throw new Error("Invalid TraceJVM package identity in release descriptor.");
  }
  if (
    typeof descriptor.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.contentHash)
  ) {
    throw new Error("Invalid TraceJVM content hash in release descriptor.");
  }
  if (
    descriptor.responsePolicy?.accessControlAllowOrigin !==
      TRACEJVM_RUNTIME_RESPONSE_POLICY.accessControlAllowOrigin ||
    descriptor.responsePolicy?.crossOriginResourcePolicy !==
      TRACEJVM_RUNTIME_RESPONSE_POLICY.crossOriginResourcePolicy ||
    descriptor.responsePolicy?.xContentTypeOptions !==
      TRACEJVM_RUNTIME_RESPONSE_POLICY.xContentTypeOptions ||
    descriptor.responsePolicy?.worker?.crossOriginEmbedderPolicy !==
      TRACEJVM_RUNTIME_RESPONSE_POLICY.worker.crossOriginEmbedderPolicy ||
    descriptor.responsePolicy?.worker?.contentSecurityPolicy !==
      TRACEJVM_RUNTIME_RESPONSE_POLICY.worker.contentSecurityPolicy
  ) {
    throw new Error("Invalid browser response policy in release descriptor.");
  }
  const relativePrefix = normalizeTraceJVMReleasePath(
    descriptor.relativePrefix,
    "release descriptor prefix",
  );
  const expectedPrefix =
    `tracejvm/${descriptor.package.version}/${descriptor.contentHash}`;
  if (relativePrefix !== expectedPrefix) {
    throw new Error(
      `Release descriptor prefix ${relativePrefix} does not match ` +
        `${expectedPrefix}.`,
    );
  }
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) {
    throw new Error("TraceJVM runtime release descriptor has no files.");
  }
  const paths = new Set();
  for (const file of descriptor.files) {
    const path = normalizeTraceJVMReleasePath(
      file.path,
      "release descriptor file path",
    );
    if (path === TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR) {
      throw new Error(
        `${TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR} cannot be a payload file.`,
      );
    }
    if (paths.has(path)) {
      throw new Error(`Duplicate release descriptor file path: ${path}`);
    }
    paths.add(path);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.integrity !== integrityFromHex(file.sha256) ||
      typeof file.contentType !== "string" ||
      file.contentType.length === 0 ||
      file.cacheControl !== TRACEJVM_RUNTIME_CACHE_CONTROL
    ) {
      throw new Error(`Invalid metadata for release file: ${path}`);
    }
  }
  for (const entrypoint of [
    descriptor.entrypoints?.browserClient,
    descriptor.entrypoints?.browserWorker,
    descriptor.entrypoints?.wasm,
    descriptor.entrypoints?.compiler,
  ]) {
    const path = normalizeTraceJVMReleasePath(
      entrypoint,
      "release descriptor entrypoint",
    );
    const present = entrypoint === descriptor.entrypoints?.compiler
      ? [...paths].some((file) => file.startsWith(`${path}/`))
      : paths.has(path);
    if (!present) {
      throw new Error(`Release entrypoint is missing from the file table: ${path}`);
    }
  }
  if (
    !descriptor.entrypoints.profiles ||
    typeof descriptor.entrypoints.profiles !== "object"
  ) {
    throw new Error("Release descriptor has no runtime profile entrypoints.");
  }
  for (const [profile, value] of Object.entries(
    descriptor.entrypoints.profiles,
  )) {
    const path = normalizeTraceJVMReleasePath(
      value,
      `runtime profile ${profile}`,
    );
    if (![...paths].some((file) => file.startsWith(`${path}/`))) {
      throw new Error(
        `Runtime profile has no files beneath its entrypoint: ${profile}`,
      );
    }
  }
  return { descriptor, descriptorPath };
}

export function verifyTraceJVMRuntimeRelease(directory) {
  const { descriptor, descriptorPath } = readTraceJVMRuntimeRelease(directory);
  const root = join(directory);
  const treeHash = createHash("sha256");
  let payloadBytes = 0;

  for (const file of [...descriptor.files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    const normalized = normalizeTraceJVMReleasePath(
      file.path,
      "release descriptor file path",
    );
    let absolute = root;
    for (const segment of normalized.split("/")) {
      absolute = join(absolute, segment);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Runtime releases must not contain symlinks: ${normalized}`);
      }
    }
    const content = readFileSync(absolute);
    const digest = sha256(content);
    if (content.byteLength !== file.size || digest !== file.sha256) {
      throw new Error(`Runtime release file identity mismatch: ${normalized}`);
    }
    treeHash.update(normalized);
    treeHash.update("\0");
    treeHash.update(content);
    treeHash.update("\0");
    payloadBytes += content.byteLength;
  }

  const contentHash = treeHash.digest("hex");
  if (contentHash !== descriptor.contentHash) {
    throw new Error(
      `Runtime release content hash mismatch: expected ` +
        `${descriptor.contentHash}, got ${contentHash}`,
    );
  }
  const descriptorContents = readFileSync(descriptorPath);
  return {
    descriptor,
    descriptorPath,
    descriptorSha256: sha256(descriptorContents),
    descriptorSize: descriptorContents.byteLength,
    payloadBytes,
  };
}
