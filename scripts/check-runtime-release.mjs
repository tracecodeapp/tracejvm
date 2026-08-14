#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  prepareTraceJVMRuntimeRelease,
  TRACEJVM_RUNTIME_CACHE_CONTROL,
  TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR,
  TRACEJVM_RUNTIME_RELEASE_SCHEMA,
  TRACEJVM_RUNTIME_RESPONSE_POLICY,
} from "./runtime-release-lib.mjs";

function parseArgs(argv) {
  const options = {
    baseUrl: null,
    publicBaseUrl: process.env.TRACEJVM_RUNTIME_PUBLIC_BASE_URL ?? null,
    requestOrigin: process.env.TRACEJVM_RUNTIME_REQUEST_ORIGIN ?? null,
    metadataOnly: false,
    timeoutMs: 60_000,
  };
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--metadata-only") options.metadataOnly = true;
    else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length).replace(/\/+$/, "");
    } else if (arg.startsWith("--public-base-url=")) {
      options.publicBaseUrl = arg
        .slice("--public-base-url=".length)
        .replace(/\/+$/, "");
    } else if (arg.startsWith("--request-origin=")) {
      options.requestOrigin = arg
        .slice("--request-origin=".length)
        .replace(/\/+$/, "");
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }
  if (!options.baseUrl && !options.publicBaseUrl) {
    throw new Error(
      "A release origin is required. Pass --base-url/--public-base-url or set TRACEJVM_RUNTIME_PUBLIC_BASE_URL.",
    );
  }
  if (!options.requestOrigin) {
    throw new Error(
      "A browser request origin is required. Pass --request-origin or set TRACEJVM_RUNTIME_REQUEST_ORIGIN.",
    );
  }
  if (!/^https?:\/\/[^/]+$/.test(options.requestOrigin)) {
    throw new Error(`Invalid request origin: ${options.requestOrigin}`);
  }
  return options;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function assertHeader(response, name, expected, url) {
  const actual = response.headers.get(name);
  if (actual !== expected) {
    throw new Error(
      `${url} returned ${name}=${JSON.stringify(actual)}; expected ` +
        `${JSON.stringify(expected)}.`,
    );
  }
}

function assertBrowserResponsePolicy(response, policy, url) {
  assertHeader(
    response,
    "access-control-allow-origin",
    policy.accessControlAllowOrigin,
    url,
  );
  assertHeader(
    response,
    "cross-origin-resource-policy",
    policy.crossOriginResourcePolicy,
    url,
  );
  assertHeader(
    response,
    "x-content-type-options",
    policy.xContentTypeOptions,
    url,
  );
}

try {
  const options = parseArgs(process.argv.slice(2));
  const local = prepareTraceJVMRuntimeRelease();
  const baseUrl =
    options.baseUrl ??
    `${options.publicBaseUrl.replace(/\/+$/, "")}/${local.relativePrefix}`;
  const descriptorUrl = `${baseUrl}/${TRACEJVM_RUNTIME_RELEASE_DESCRIPTOR}`;
  const descriptorResponse = await fetchWithTimeout(
    descriptorUrl,
    {
      redirect: "follow",
      headers: { Origin: options.requestOrigin },
    },
    options.timeoutMs,
  );
  if (!descriptorResponse.ok) {
    throw new Error(
      `${descriptorUrl} returned HTTP ${descriptorResponse.status}.`,
    );
  }
  assertHeader(
    descriptorResponse,
    "cache-control",
    TRACEJVM_RUNTIME_CACHE_CONTROL,
    descriptorUrl,
  );
  assertBrowserResponsePolicy(
    descriptorResponse,
    TRACEJVM_RUNTIME_RESPONSE_POLICY,
    descriptorUrl,
  );
  assertHeader(
    descriptorResponse,
    "content-type",
    "application/json; charset=utf-8",
    descriptorUrl,
  );
  const remote = await descriptorResponse.json();
  if (remote.schema !== TRACEJVM_RUNTIME_RELEASE_SCHEMA) {
    throw new Error(`Unexpected remote release schema: ${remote.schema}`);
  }
  if (
    remote.contentHash !== local.contentHash ||
    remote.relativePrefix !== local.relativePrefix
  ) {
    throw new Error(
      `Remote release ${remote.relativePrefix} does not match local ` +
        `${local.relativePrefix}.`,
    );
  }

  for (const file of remote.files) {
    const url = `${baseUrl}/${file.path}`;
    const response = await fetchWithTimeout(
      url,
      {
        method: options.metadataOnly ? "HEAD" : "GET",
        redirect: "follow",
        headers: { Origin: options.requestOrigin },
      },
      options.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}.`);
    }
    assertHeader(response, "cache-control", file.cacheControl, url);
    assertHeader(response, "content-type", file.contentType, url);
    assertBrowserResponsePolicy(response, remote.responsePolicy, url);
    if (file.path === remote.entrypoints.browserWorker) {
      assertHeader(
        response,
        "cross-origin-embedder-policy",
        remote.responsePolicy.worker.crossOriginEmbedderPolicy,
        url,
      );
      assertHeader(
        response,
        "content-security-policy",
        remote.responsePolicy.worker.contentSecurityPolicy,
        url,
      );
    }
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength =
      contentLengthHeader === null ? null : Number(contentLengthHeader);
    if (
      contentLength !== null &&
      Number.isFinite(contentLength) &&
      contentLength !== file.size
    ) {
      throw new Error(
        `${url} returned ${contentLength} bytes; expected ${file.size}.`,
      );
    }
    if (!options.metadataOnly) {
      const content = Buffer.from(await response.arrayBuffer());
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== file.sha256) {
        throw new Error(
          `${url} sha256 ${actualSha256} did not match ${file.sha256}.`,
        );
      }
    }
    console.log(`PASS ${file.path}`);
  }
  console.log(`TraceJVM runtime release is available at ${baseUrl}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
