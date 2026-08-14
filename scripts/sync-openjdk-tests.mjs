import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(root, "compatibility/openjdk/manifest.json"), "utf8"),
);
const checkout = join(root, ".cache/openjdk-jdk23u");
if (!existsSync(join(checkout, ".git"))) {
  mkdirSync(dirname(checkout), { recursive: true });
  execFileSync(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      manifest.upstream.repository,
      checkout,
    ],
    { stdio: "inherit" },
  );
}
execFileSync("git", ["-C", checkout, "fetch", "--depth=1", "origin", manifest.upstream.commit], {
  stdio: "inherit",
});
execFileSync("git", ["-C", checkout, "checkout", "--detach", manifest.upstream.commit], {
  stdio: "inherit",
});

for (const test of manifest.tests) {
  const source = join(checkout, "test", manifest.suite, test.path);
  const destination = join(root, "compatibility/openjdk/tests", test.path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  const digest = createHash("sha256").update(readFileSync(destination)).digest("hex");
  if (digest !== test.sha256) {
    throw new Error(`OpenJDK source checksum changed for ${test.path}`);
  }
}
