#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const profilePath = resolve(process.argv[2] ?? 'reports/firefox-gecko-profile.json');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));

function collectThreads(node) {
  return [
    ...(node.threads ?? []),
    ...(node.processes ?? []).flatMap((process) => collectThreads(process)),
  ];
}

function column(table, name) {
  const index = table.schema[name];
  if (index === undefined) {
    throw new Error(`Gecko profile table is missing the "${name}" column.`);
  }
  return index;
}

function summarizeThread(thread) {
  const sampleStack = column(thread.samples, 'stack');
  const stackPrefix = column(thread.stackTable, 'prefix');
  const stackFrame = column(thread.stackTable, 'frame');
  const frameLocation = column(thread.frameTable, 'location');
  const leaf = new Map();
  const inclusive = new Map();
  let wasmSamples = 0;

  for (const sample of thread.samples.data) {
    let stackIndex = sample[sampleStack];
    let isLeaf = true;
    let hasWasm = false;

    while (stackIndex !== null && stackIndex !== undefined) {
      const stack = thread.stackTable.data[stackIndex];
      const frame = thread.frameTable.data[stack[stackFrame]];
      const location = thread.stringTable[frame[frameLocation]] ?? '<unknown>';
      inclusive.set(location, (inclusive.get(location) ?? 0) + 1);
      if (isLeaf) {
        leaf.set(location, (leaf.get(location) ?? 0) + 1);
        isLeaf = false;
      }
      if (location.includes('bjvm_main.wasm')) {
        hasWasm = true;
      }
      stackIndex = stack[stackPrefix];
    }

    if (hasWasm) {
      wasmSamples++;
    }
  }

  return {
    thread,
    totalSamples: thread.samples.data.length,
    wasmSamples,
    leaf,
    inclusive,
  };
}

function topEntries(counts, totalSamples, limit = 20) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([frame, samples]) => ({
      frame,
      samples,
      percent: Number(((samples / totalSamples) * 100).toFixed(2)),
    }));
}

const candidates = collectThreads(profile)
  .filter((thread) => thread.samples?.data && thread.stackTable?.data && thread.frameTable?.data)
  .map(summarizeThread)
  .sort((left, right) => right.wasmSamples - left.wasmSamples);

const selected = candidates[0];
if (!selected || selected.wasmSamples === 0) {
  throw new Error('No sampled thread containing bjvm_main.wasm frames was found.');
}

process.stdout.write(`${JSON.stringify({
  profile: profilePath,
  product: profile.meta?.product,
  version: profile.meta?.version,
  intervalMilliseconds: profile.meta?.interval,
  thread: {
    name: selected.thread.name,
    processName: selected.thread.processName,
    pid: selected.thread.pid,
    tid: selected.thread.tid,
  },
  totalSamples: selected.totalSamples,
  wasmSamples: selected.wasmSamples,
  wasmSamplePercent: Number(
    ((selected.wasmSamples / selected.totalSamples) * 100).toFixed(2),
  ),
  topLeafFrames: topEntries(selected.leaf, selected.totalSamples),
  topInclusiveFrames: topEntries(selected.inclusive, selected.totalSamples),
}, null, 2)}\n`);
