# Compiler/runner split prototype

Status: historical 0.2 experiment, superseded by the 0.4 architecture

> This document preserves the measurements that motivated the split. Its
> combined `TraceJVMRuntimeHost` conclusion was rejected during the 0.4
> cutover. Current code keeps compiler capability separate and offers a
> runner-only host for amortizing immutable JDK/Wasm loading.

## Question

Can TraceJVM keep a compiler VM warm while disposable runner VMs execute the
resulting class artifacts?

The prototype answers the functional question **yes**. It rejects separate
compiler and runner Workers, then proves a `TraceJVMRuntimeHost` topology with
one Wasm substrate, one persistent compiler JVM, and replaceable process JVMs.

## Prototype boundary

`TraceJVMOptions.role` selects one of three physical engine roles:

- `combined` preserves the existing compile-and-run behavior.
- `compiler` accepts `compile` and rejects `run` and `execute`.
- `runner` accepts `run`, rejects `compile` and `execute`, and does not load
  `compiler-23.jar`. The JDK `lib/modules` image remains runner data used by
  class loading and reflection.

The compiled program remains the existing transportable
`TraceJVMCompiledProgram`: a set of relative paths and byte arrays. There is no
shared VM state or hidden compiler dependency. The browser probe terminates the
compiler, runs the artifact in a runner, terminates that runner, and runs the
same artifact in a replacement runner.

The runner can omit the compiler platform module image. It still uses the same
TraceJVM Wasm module, Java runtime JAR, TraceKernel API classes, bridge,
filesystem substrate, and independent Java heap as the combined engine.

The second prototype implements real disposal in the vendored VM layer:

- Native disposal tears down the scheduler and its execution records before
  freeing VM threads, class loaders, class metadata, handles, heap, unsafe
  allocations, mappings, and streams.
- JavaScript disposal cancels scheduler timers, wakes pending method promises,
  unregisters finalizers, invalidates handles, removes Wasm callback-table
  entries, and makes subsequent VM use fail explicitly.
- `TraceJVMEngine.dispose()` now performs VM disposal and no longer requires
  Worker termination for correctness.

The shared prototype loads runtime assets once, retains the compiler JVM, and
creates 16 MiB process JVMs inside the same `TraceJVMRuntimeHost`. Process
disposal does not destroy the compiler or the shared runtime substrate.

## Evidence

Run:

```sh
pnpm build:test-browser
pnpm test:compiler-runner-split
pnpm measure:compiler-runner-split
RUNNER_HEAP_BYTES=16777216 node tests/browser/measure-compiler-runner-split.mjs reports/compiler-runner-split-16m.json
pnpm test:shared-runtime-lifecycle
REPLACEMENTS=100 node tests/browser/measure-shared-runtime-memory.mjs reports/shared-runtime-memory-100.json
pnpm measure:warm-compiler-policy
ORDER=shared-first pnpm measure:warm-compiler-policy
```

The lifecycle and artifact transfer probe passes in Chromium, Firefox, and
WebKit. Both the original and replacement runners report clean process
isolation.

Chromium measurements are process RSS above the page-ready baseline. They are
directional rather than a release benchmark because browser process retention
and allocator behavior vary between launches.

| Topology | Peak incremental RSS | Runner-only RSS | Compiler init | Runner init | Compile | First run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Combined, 64 MiB heap | 279.0–281.5 MiB | n/a | 231–271 ms | n/a | 2473–2479 ms | 36–37 ms |
| Split, 64 + 64 MiB heaps | 385.3–406.4 MiB | 184.8–205.6 MiB | 212–226 ms | 116–119 ms | 2479–2493 ms | 103–105 ms |
| Split, 64 + 16 MiB heaps | 387.4 MiB | 187.3 MiB | 211.1 ms | 128.5 ms | 2500.0 ms | 106.8 ms |

Across repeated 64 MiB measurements the split adds 103.8–124.9 MiB, or
36.9–44.4%, to peak RSS. A 16 MiB runner still produced a 387.4 MiB peak.
Browser allocator retention makes comparisons between separate launches noisy,
but reducing the Java heap by 48 MiB plainly does not remove the duplicated
BJVM/Wasm/runtime cost.

The runner initialization request set falls from 29,731,715 bytes for a full
engine to 14,392,833 bytes. It avoids:

- `jdk23/lib/modules`: 12,077,450 bytes
- `compiler-23.jar`: 3,261,432 bytes

That makes runner initialization roughly twice as fast, but network asset
reduction does not translate into a similarly large RSS reduction.

### Shared runtime-host result

The shared lifecycle probe keeps the compiler alive across runner disposal,
reuses it for a second compile, and replaces the runner repeatedly. It passes
in Chromium, Firefox, and WebKit with clean TraceJVM isolation reports.
It also disposes a runner while Java is blocked in `Thread.sleep`, then compiles
and runs another program with the same compiler VM. This forced-retirement path
passes in all three engines and is the relevant primitive for process timeout
or cancellation without killing the compiler.

| Browser | Shared runtime init | First compile | Warm second compile | Replacement runner init | Run |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 229–293 ms | 1328–1379 ms | 463–471 ms | 39–47 ms | 89–118 ms |
| Firefox | 258 ms | 5724 ms | 1675 ms | 167–182 ms | 487–499 ms |
| WebKit | 207 ms | 1352 ms | 533 ms | 32–36 ms | 110–118 ms |

A 100-runner Chromium replacement campaign measured:

- compiler ready: 210.4 MiB incremental RSS
- compiler after compilation: 294.5 MiB
- peak with runner activity: 355.2 MiB
- after all VMs were disposed and browser reclamation ran: 242.6 MiB

Wasm linear memory retains its high-water capacity, so immediate RSS does not
fall on every `dispose()`. The allocator evidence shows that the VMs themselves
are freed and their memory is reusable:

- post-compile live allocation: 219.02 MiB
- active runner after execution: about 289.4 MiB
- after runner 1 disposal: 219.02 MiB
- after runner 100 disposal: 219.13 MiB
- Wasm heap capacity reached 349.69 MiB on the second runner and remained
  stable through runner 100

The roughly 0.11 MiB live-allocation increase over 100 complete JVM lifecycles
is small enough for the topology proof, but should remain a ratcheted lifecycle
budget during productization.

### Warm compiler policy result

The policy benchmark measures the product-relevant edit loop, not repeated
execution of an unchanged artifact. Every sample changes the Java source,
compiles it, creates a new runner JVM, runs the new artifact, and disposes that
runner. The baseline creates and disposes a fresh combined compiler/runner JVM
for the same operation.

Five steady-state samples were measured in both policy orders so browser-level
asset and JIT caches could not systematically favor the shared runtime:

| Browser | Order | Fresh combined JVM | Warm compiler + fresh runner | Saved | Speedup |
| --- | --- | ---: | ---: | ---: | ---: |
| Chromium | baseline first | 2818 ms | 1055 ms | 1763 ms (62.6%) | 2.67x |
| Chromium | shared first | 2845 ms | 1057 ms | 1788 ms (62.9%) | 2.69x |
| Firefox | baseline first | 10590 ms | 4217 ms | 6373 ms (60.2%) | 2.51x |
| Firefox | shared first | 10888 ms | 4014 ms | 6874 ms (63.1%) | 2.71x |
| WebKit | baseline first | 2520 ms | 1183 ms | 1337 ms (53.1%) | 2.13x |
| WebKit | shared first | 2586 ms | 1187 ms | 1399 ms (54.1%) | 2.18x |

The retained compiler accounts for the improvement. Its median compile step
falls from 2.54–2.57 seconds to 0.89 seconds in Chromium, from 10.10–10.41
seconds to 3.31–3.48 seconds in Firefox, and from 2.33–2.37 seconds to
1.03–1.04 seconds in WebKit. A replacement runner is more expensive than
running in the already-initialized combined VM, but its roughly 150 ms
Chromium/WebKit or 700 ms Firefox initialization-and-run cost is much smaller
than the retained compiler's saving.

Background-initializing a replacement combined JVM before every compile is a
fairer control for a warm-and-retire product policy. It removes combined JVM
initialization from the user-visible interval, but still retires the compiler
with the runner after execution:

| Browser | Prewarmed combined, then retire | Retained compiler + fresh runner | Saved | Speedup |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 2614 ms | 1054 ms | 1561 ms (59.7%) | 2.48x |
| Firefox | 10088 ms | 4073 ms | 6015 ms (59.6%) | 2.48x |
| WebKit | 2339 ms | 1167 ms | 1172 ms (50.1%) | 2.00x |

Prewarming the combined JVM therefore recovers only its 166–293 ms
initialization cost. It does not preserve the much larger `javac` first-use
state, so retaining the compiler remains a 2.00–2.48x improvement over the
strongest combined warm-and-retire control.

This is a steady-state result, not a cold-start improvement. The first compile
still warms the compiler and takes approximately as long as the combined
baseline. Even when runtime-host initialization happens in the background, the
first candidate cycle is only modestly faster in Chromium and slower in
Firefox and WebKit. The measured benefit begins with the next edit, which makes
background prewarming and compiler survival across runner retirement necessary
parts of the policy rather than optional optimizations.

The existing release compatibility matrix remains green after the BJVM
disposal changes: 35/35 cases in Chromium, Firefox, WebKit, and WebKit iPad
emulation. The existing abort/recovery lifecycle probe also remains green.

## Architectural result

Both required engine boundaries are viable:

1. Class artifacts cross compiler/runner boundaries without shared Java state.
2. Runner VMs can be destroyed and replaced without destroying the warm
   compiler JVM or duplicating the TraceJVM Wasm runtime.

The experiment proved that immutable runtime substrate can be shared without
sharing learner JVM state. The shipped direction is narrower:

The experiment now includes these product-facing boundaries:

1. `TraceJVMCompiler` or `TraceJVMCompilerWorkerClient` owns only the warm
   compiler.
2. `TraceJVMRunnerHost` may share immutable JDK/Wasm loading while creating
   disposable `TraceJVMProcess` leases; it has no compiler capability.
3. Every process JVM has a distinct process-bound TraceKernel dispatcher,
   working directory, output route, and local scratch namespace.
4. Concurrent Java processes may share the runner substrate but have
   independent Java heaps and VM state. A three-browser conformance probe runs
   two processes concurrently and proves distinct PIDs and `user.dir` values.
5. Provider-local `processFiles` are rejected on this API. Kernel-bound files
   must be provisioned through TraceKernel, which remains the filesystem
   authority. A process created without a host is an explicit compatibility
   fallback for browser documents where synchronous kernel transport is
   unavailable; it receives only runner-local process files and is not the
   production kernel topology.
6. Epoll, eventfd, inotify, and outstanding asynchronous host calls are owned
   by a JVM process context and cleaned when its lease is disposed.

The combined runtime-host Worker prototype and its gates were removed. Browser
embedders now compose compiler-only and runner-only lifecycles explicitly.

Remaining product integration work:

1. Define the TraceKernel admission and automatic rewarm handshake around the
   process lease API.
2. Establish compatibility-tested runner heap tiers rather than treating the
   successful 16 MiB probe as a universal Java memory limit.
3. Keep the 100-cycle allocator delta and peak RSS as explicit lifecycle
   budgets.

TraceKernel should continue to own logical process leases, taint, and
retirement decisions. TraceJVM should expose the physical capabilities and
replacement signals. The compiler and runner roles are an engine topology, not
a new kernel semantic.
