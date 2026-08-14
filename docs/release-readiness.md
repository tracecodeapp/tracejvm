# Release readiness

## TraceJVM 0.4 update

Measured: 2026-08-04

TraceJVM 0.4 makes the compiler/runner boundary introduced in 0.3 physical.
The pinned TeaVM-javac Wasm-GC compiler and classfile runner now have
independent Worker lifecycles rather than a combined host:

- `TraceJVMCompiler` is the sole source compiler.
- `TraceJVMEngine` and the single-engine Worker are classfile runners only.
- `TraceJVMCompilerWorkerClient` keeps one compiler warm while embedders own
  independently disposable `TraceJVMWorkerClient` runners.
- `TraceJVMRunnerHost` optionally amortizes immutable runtime loading across
  disposable JVMs without acquiring compiler capability.
- Runtime profiles no longer contain `compiler-23.jar`. They retain the JDK
  module image because class loading and runtime reflection consume it.
- The Worker protocol contains no single-engine `compile` or `execute`
  operation.

The first 0.4 gates pass for classfile version 67 output, packaged source paths,
compiler diagnostics, compile/run separation, and runner process isolation in
Chromium, Firefox, and WebKit. Full OpenJDK, lifecycle, downstream
corpus, and release-asset gates must be rerun before tagging 0.4.0.

The sections below record the 0.2 baseline that motivated this replacement.
Compiler timings and compiler-memory conclusions there are historical, not the
0.4 implementation.

## TraceJVM 0.2 historical baseline

Measured: 2026-07-27

## Decision

TraceJVM's `openjdk-23-core-browser-v1` engine is a credible integration
candidate, not a committed stable architecture and not yet a universal
CheerpJ replacement. The core compiler/runtime, lifecycle, and browser
isolation boundary are mature enough for consumer experiments. The remaining
compatibility and embedding work still determines where this engine ships.

The current release-candidate path keeps the pinned, vendored b-jvm engine
behind TraceJVM's API while application adapters are evaluated. That does not
preclude focused performance exploration. The default-off profiler,
exact-intrinsic proof, and profile-guided AOT proposal are documented in
`docs/hot-path-exploration.md`. The first generated-AOT milestone now clears
its narrow correctness, payload, memory, and Firefox-performance continuation
gate. A second six-method array-loop slice also passes its OpenJDK differential
oracle and improves all measured browsers. A third slice brings the generated
subset to seventeen static no-call methods, passes the complete matrix both
enabled and disabled, and improves paired warm compiler medians by 13–17%
across the four browser targets for a 0.56% Wasm cost. Firefox variance,
insufficiently paired memory measurement, and the then-unproven object-field
boundary kept the feature explicitly default-off. A fourth slice now places
`String.coder()` and `String.isLatin1()` below normal instance dispatch, uses
runtime-resolved field metadata rather than embedded offsets, passes the
native differential oracle and both enabled/disabled 108-case release gates,
and improves paired compiler medians by 10.0–14.1% for a total 0.88% Wasm
cost. That is a positive continuation result, but the experiment remains
default-off until product-corpus, physical-device, and consumer-adapter gates
are complete. A fifth bounded slice adds three pinned leaf methods, passes the
four-browser oracle with zero generated exceptions, passes the full 108-case
matrix both enabled and disabled, and improves the preceding artifact's warm
compiler median by a further 10.7–10.8% in Firefox and Chromium for 1,045
bytes of Wasm. The next hot methods require allocation, nested Java calls,
validation policy, reference-field composition, or exception tables, so they
are an architectural tier boundary rather than candidates for one-off C
shortcuts. These results permit further engineering exploration; they are not
a production commitment.
A clean-room rewrite or continuously synchronized b-jvm fork is not justified
by current evidence.

## Supported profile

The machine-readable contract is
`compatibility/openjdk/release-profile.json`:

- Eclipse Temurin/OpenJDK `23.0.2+7` is the compiler and behavior oracle.
- Java source and target level are 23, without preview features.
- The supported runtime is `core` (`java.base`).
- Release browsers are Chromium, Firefox, WebKit, and WebKit with iPad
  emulation.
- Larger `server` and `spring-server` images remain experimental.

The profile deliberately excludes JNI, unimplemented OpenJDK native
boundaries, GUI/audio integration, operating-system process creation,
unrestricted host filesystem/network access, and modules outside `java.base`.

## Permanent release gate

The permanent browser gate currently contains 31 lifecycle, compatibility,
isolation, filesystem, compiler, and byte-for-byte upstream OpenJDK 23 cases.
It passed in every release browser after the Java 23 reference-native fix:

| Browser | Passed | Wall time |
| --- | ---: | ---: |
| Chromium | 31 / 31 | 31.9 s |
| Firefox | 31 / 31 | 111.7 s |
| WebKit | 31 / 31 | 29.1 s |
| WebKit, iPad emulation | 31 / 31 | 29.3 s |

The OpenJDK lane includes primitive wrappers, parsing, enums, references,
reflection/proxies, annotations, string concatenation/invokedynamic, interface
method reflection, file-descriptor behavior, compilation diagnostics, abort
recovery, thread-local/reference semantics, and process-state isolation.

## Discovery campaign

The deterministic 50-case discovery shard is selected from the complete
catalog of direct-main candidates in OpenJDK's `java/lang`, `java/util`, and
`java/io` trees. Native OpenJDK compiles and runs each case first. TraceJVM then
compiles the same source, compares class-file hashes, and compares deterministic
observable behavior.

The generated report is `reports/openjdk-campaign.json`. Every non-pass has
one explicit classification. Unsupported and non-standalone upstream tests
remain in the denominator instead of disappearing from a curated pass set.

| Result | Count |
| --- | ---: |
| Selected | 50 |
| Native-oracle runnable | 39 |
| Passed | 22 |
| TraceJVM semantic defects | 0 |
| Missing runtime module | 8 |
| Missing native | 3 |
| Unsupported browser capability | 0 |
| Test infrastructure | 11 |
| Timeout | 6 |

The 11 infrastructure results are four preview-mode sources, four sources that
do not compile standalone, and three multi-step tests whose selected invocation
cannot run independently. Five workloads exceeded the browser campaign's
20-second guard, and one test reported that its own internal deadline expired.

The three missing-native cases are two StackWalker tests and lambda
class-loader serialization. The eight module results require
`java.management` or `java.logging`, which are intentionally outside the core
profile. The timeouts are large concurrency/performance workloads, not
unclassified hangs. These results define concrete compatibility boundaries;
they are not counted as semantic passes.

## Performance and memory

The current three-run phase benchmark measured:

| Browser | Runtime init | Cold `javac` | Warm `javac` |
| --- | ---: | ---: | ---: |
| Chromium | 0.23 s | 2.10 s | 0.66–0.67 s |
| Firefox | 0.31 s | 9.07 s | 2.86–2.91 s |
| WebKit | 0.18 s | 2.03 s | 0.64–0.65 s |

Longer earlier Firefox samples placed cold compilation at approximately
11–13 seconds and warm compilation at 2.82–3.68 seconds. Profiling attributes
the gap to
interpreted Java compiler work rather than browser host setup, filesystem
transfer, or class execution. Dispatcher and scheduler-crossing experiments
did not close it. A compiled tier may be a later optimization, but it is not a
release prerequisite and must not replace compatibility work.

The measured `core` profile costs 29.2 MB of cold assets, approximately
212.6 MB runtime RSS over the page baseline, and approximately 271.1 MB peak
RSS over baseline in Chromium. The production Worker bundle is approximately
485 KB after retained `-O2` payload optimization.

The standalone lifecycle stress gate completes 12 isolated executions in each
release browser, observes the configured retirement boundary at execution 8,
and completes three hard-abort/fresh-Worker recovery cycles. A ten-cycle
Chromium process-RSS probes reach allocator high water rather than returning
to the original page baseline after each Worker termination. Across two
ten-cycle probes, retained RSS grew by 51–69 MB from cycle 1, while the final
three cycles stayed within 0.45–4.1 MB. This is evidence of a plateau, not
proof that a physical low-memory browser will behave identically; physical
iPad validation remains required.

## Downstream consumer evidence

The downstream corpus gate executes authored Java reference solutions and tests
through the real TraceJVM Worker. It does not substitute synthetic examples
for application behavior.

- Direct execution: all 80 Java programs compiled and all 1,232 authored cases
  matched in Chromium.
- Instrumented execution: all 200 Java programs compiled and all 2,352 authored
  cases matched in Chromium. Reaching zero exposed and fixed two
  consumer-corpus defects:
  problem-level semantic validators were not inherited by the corpus runner,
  and generated `accounts-merge` references incorrectly merged disconnected
  accounts that merely shared an owner name.
- The representative cross-browser shard contains seven real programs and 96
  authored cases spanning arrays, linked structures, object state, collections,
  parsing, and staged solutions. It passed 96/96 in Chromium,
  Firefox, WebKit, and WebKit with iPad emulation.
- No authored hosted multi-file Java corpus exists yet, so that coverage is
  zero rather than an inferred pass.

The separate embedding gate constructs a browser workspace and exercises
`javac`, repeated class execution, classpath JARs, and executable JARs through
TraceJVM. It also runs a production source rewriter and helper JAR, captures
call, line, return, and snapshot events from ordinary helper bytecode, and
reconstructs them outside the VM. It passes in Chromium, Firefox, and WebKit.
The complete Java semantic-instrumentation matrix also passes unchanged
through TraceJVM: all 84 Java-applicable fixtures pass in Chromium
(165.9 seconds), Firefox (428.9 seconds), and WebKit (156.9 seconds). Those
fixtures retain strict assertions over events, snapshots, access provenance,
calls/returns, mutations, line sequences, output, and exceptions. This proves
the source-instrumentation, compile/run, and execution/reconstruction seams.

A direct Chromium provider differential runs those same 84 fixtures through
the real CheerpJ 4.2 browser worker and TraceJVM. All 84 are exact matches at
all three observable layers: raw `TraceHooks` event arrays, reconstructed
frontend runtime traces, and returned outputs. The CheerpJ side runs in bounded
fresh-VM chunks for semantic comparison. A separate unbounded warm-session
probe reproducibly aborts at Java fixture 70 (`queue-fifo`) after the preceding
69 fixtures succeed, while that fixture passes in a fresh CheerpJ VM and in
TraceJVM. That is a CheerpJ lifecycle/reliability difference, not a trace
content difference.

## Remaining blockers

1. **Hosted application corpus:** at least one representative multi-file Java
   application must pass before hosted-project support is claimed.
2. **Process-host integration:** a production host adapter must pass process,
   filesystem, environment, terminal, network, cancellation, and isolation
   gates through TraceJVM's public capability boundary.
3. **Physical Safari:** run the release gate and representative consumer flow
   on a physical iPad. WebKit iPad emulation is not a substitute.
4. **Distribution:** make the package/runtime asset release reproducible from a
   clean checkout, publish or vendor the candidate intentionally, and verify
   the consuming application uses the exact pinned artifacts.
5. **Telemetry and rollback:** the consuming application must distinguish the
   selected provider and classify compile, runtime, infrastructure, and timeout
   failures before any canary. A TraceJVM canary must retain an explicit
   provider rollback; passing local gates is not authorization to change a
   public rollout.

## Exact CheerpJ replacement criteria

CheerpJ can be removed from a consumer only when all of the following are true:

1. `pnpm test:release` passes all permanent gates in all four release browser
   targets.
2. The current oracle campaign contains no unclassified result and no
   `tracejvm-semantic-defect` within the supported profile.
3. That consumer's complete Java corpus passes with no reliance on an excluded
   module, native, or browser capability.
4. The consumer-owned adapter passes correctness, tracing (where applicable),
   cancellation, isolation, filesystem, and lifecycle tests with no CheerpJ
   fallback.
5. Cold start, warm compilation, memory, and payload remain within the
   documented budgets on supported desktop browsers and a physical iPad.
6. A clean production build resolves only the pinned TraceJVM engine, OpenJDK,
   and runtime artifacts, and post-deploy telemetry distinguishes compile,
   runtime, infrastructure, and timeout failures.

Meeting these criteria for one consumer permits a one-way cutover for that
consumer. It does not require waiting for every experimental runtime profile,
nor does it justify claiming full Java SE compatibility.
