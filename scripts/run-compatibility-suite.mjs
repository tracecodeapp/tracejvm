import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  ["build", "&&", "pnpm", "build:test-browser", "&&", "node", "tests/browser/run-matrix.mjs"],
  {
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      BROWSERS: process.env.BROWSERS ?? "chromium",
    },
  },
);
process.exitCode = result.status ?? 1;
