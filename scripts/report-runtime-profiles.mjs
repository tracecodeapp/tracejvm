import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = resolve(
  process.env.TRACEJVM_ASSETS_ROOT ?? join(root, "runtime/assets"),
);
const outputPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const manifest = JSON.parse(
  readFileSync(join(root, "runtime/manifest.json"), "utf8"),
);

function describeFile(path) {
  const content = readFileSync(path);
  return {
    bytes: statSync(path).size,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

const shared = {
  wasm: describeFile(join(assetsRoot, "bjvm_main.wasm")),
};
const profiles = {};

for (const profile of ["core", "server", "spring-server"]) {
  const profileRoot = join(assetsRoot, "profiles", profile);
  const files = {
    bootJar: describeFile(join(profileRoot, "jdk23.jar")),
    traceKernelApi: describeFile(join(profileRoot, "tracekernel-api.jar")),
    modulePackageMap: describeFile(
      join(profileRoot, "jdk23/lib/module-packages.map"),
    ),
    timezoneDatabase: describeFile(join(profileRoot, "jdk23/lib/tzdb.dat")),
    ...(profile === "core"
      ? {}
      : {
          loggingConfiguration: describeFile(
            join(profileRoot, "jdk23/conf/logging.properties"),
          ),
        }),
  };
  profiles[profile] = {
    modules: manifest.profiles[profile],
    files,
    coldAssetBytes:
      shared.wasm.bytes +
      Object.values(files).reduce((total, file) => total + file.bytes, 0),
  };
}

const report = {
  schema: "tracejvm.runtime-profile-measurement.v1",
  javaVersion: manifest.javaVersion,
  target: "linux-x64-class-library",
  notes: [
    "coldAssetBytes counts the VM Wasm once and all files fetched by a cold profile Worker",
    "files are already internally compressed JAR or jimage artifacts, so HTTP recompression saves little",
    "Spring server includes java.desktop for java.beans and introspection; this does not claim GUI support",
  ],
  shared,
  profiles,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;

if (outputPath) writeFileSync(outputPath, serialized);
else process.stdout.write(serialized);
