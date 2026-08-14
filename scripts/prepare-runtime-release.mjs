#!/usr/bin/env node

import { prepareTraceJVMRuntimeRelease } from "./runtime-release-lib.mjs";

try {
  const release = prepareTraceJVMRuntimeRelease();
  console.log(JSON.stringify({
    schema: release.descriptor.schema,
    version: release.version,
    contentHash: release.contentHash,
    relativePrefix: release.relativePrefix,
    outputDirectory: release.outputDirectory,
    descriptorPath: release.descriptorPath,
    descriptorSha256: release.descriptorSha256,
    assetCount: release.assetCount,
    payloadBytes: release.payloadBytes,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
