# Firefox performance investigation

TraceJVM's Firefox gap is inside the interpreted Java work performed by
`javac`, not in the browser host, filesystem, compiler artifact transfer, or
execution of the resulting class.

## Reproducing the measurements

The phase-split browser benchmark compiles and runs the same Java 23 source in
Chromium, Firefox, and WebKit:

```sh
PORT=8765 \
BROWSERS=chromium,firefox,webkit \
REPETITIONS=5 \
PREEMPTION_US=1000 \
pnpm measure:firefox-performance
```

The generated report is written to `reports/firefox-performance.json`. Each
case has a hard timeout (`CASE_TIMEOUT_MS`, default 60 seconds) and announces
its browser and preemption setting before it starts.

The benchmark records:

- browser OS/runtime initialization
- VM construction
- compiler bridge loading
- source filesystem setup
- `javac`
- class artifact reads
- running the compiled class
- cleanup
- scheduler step counts for compilation and execution

## Baseline

On an otherwise idle development machine, a warm compile of the benchmark
source took approximately:

| Engine | Warm `javac` |
| --- | ---: |
| Chromium | 0.70–0.76 s |
| WebKit | 0.70–0.74 s |
| Firefox | 2.82–3.68 s |

Firefox cold compilation took approximately 11–13 seconds, while Chromium and
WebKit took approximately 2.1–2.4 seconds. The warm compiler scheduler step
count was initially identical across browsers: 59. Setup, artifact reads, and
cleanup were sub-millisecond operations, and running the compiled class took
roughly 12–15 ms in Firefox versus 7–8 ms in Chromium and WebKit.

Repeating twelve compilations did not produce a late Firefox tier-up. Warm
compiles remained approximately 2.6–3.2 seconds in an idle run.

## Experiments

### Optimize the final browser runtime

The Emscripten link and b-jvm Binaryen postprocessing levels were raised from
`-O0` to `-O2`.

- runtime Wasm: 923 KB to 686 KB (about 26% smaller)
- benchmark worker bundle: about 182 KB to 149 KB
- production worker bundle: about 516 KB to 485 KB
- no material warm `javac` speed improvement in Firefox

The change is retained for its payload benefit, not presented as a Firefox
execution optimization.

### Portable indirect-call dispatcher

The Emscripten-only typed-function-reference dispatcher was replaced
experimentally with b-jvm's existing portable `call_indirect` fallback.
Firefox warm compilation stayed at approximately 2.97–3.00 seconds. Chromium
and WebKit also did not improve. The experiment was reverted.

### Split dispatcher and reduced live state

The monolithic no-tail-call dispatcher was split into four no-inline functions,
one for each top-of-stack kind. A second variant kept the interpreter state in
memory rather than carrying it through each group as locals. Both variants
executed the same correctness workload successfully, but both were materially
slower in every browser:

| Variant | Chromium `javac` / run | Firefox `javac` / run | WebKit `javac` / run |
| --- | ---: | ---: | ---: |
| Monolithic baseline | 2.11 s / 0.62 s | 9.76 s / 3.54 s | 1.88 s / 0.56 s |
| Split, local state | 3.15 s / 0.99 s | 13.60 s / 4.81 s | 2.67 s / 0.83 s |
| Split, memory state | 3.23 s / 1.03 s | 13.52 s / 4.84 s | 2.58 s / 0.82 s |

The smaller functions did not improve Firefox code generation. Crossing the
group boundary and synchronizing interpreter state cost roughly 35–50% instead.
Both variants were removed.

### Firefox tiering and optimizer controls

Firefox was measured under its default lazy tiering, synchronous optimization
on the first call, eager whole-module optimization, disabled Wasm loop
unrolling, disabled direct-call inlining, minimum Wasm inlining, and the simple
Ion register allocator. None materially improved the workload. For example,
the same cold correctness workload measured 9.80 s `javac` / 3.62 s run under
the default configuration and 9.84 s / 3.53 s when optimization was requested
on the first call. Eager optimization measured 10.24 s / 3.56 s.

This rules out a delayed tier-up and the exposed SpiderMonkey optimizer
settings as the primary loss. The measurement runner accepts
`FIREFOX_WASM_TIERING_MODE` and `FIREFOX_WASM_PREFS_JSON` so future Firefox
versions can be checked without changing production behavior.

### Scheduler fuel

The interpreter's 200,000-instruction fuel budget was made configurable for an
experiment. Raising it to one million cut the warm Firefox scheduler crossings
from 59 to 12.

An alternating same-worker comparison under identical machine load measured:

- 200,000 fuel: 8.131 s and 7.379 s warm compiles
- 1,000,000 fuel: 7.213 s, 6.850 s, and 8.190 s warm compiles

The machine was heavily contended during this experiment, so these absolute
times are not baseline results. The same-worker comparison is still sufficient
to show that a roughly fivefold reduction in scheduler crossings produced only
a small, noisy median difference. It cannot close Firefox's roughly fourfold
idle-runtime gap and would weaken cooperative scheduling. The configurable
fuel code was removed and the production value remains 200,000.

### Dormant b-jvm JIT

b-jvm contains an unfinished per-method Wasm JIT, but `attempt_jit` explicitly
disables it before compilation. Enabling it is not a safe optimization switch:
it needs correctness, interruption, deoptimization, memory ownership, and
browser lifecycle work before it can be evaluated as a production tier.

## Structural attribution

TraceJVM has default-off diagnostics for separating interpreter cost from
allocation, garbage collection, scheduler, and host-boundary cost:

```sh
DIAGNOSTIC_METRICS=1 \
BOUNDARY_PROBE_ITERATIONS=100000 \
BROWSERS=chromium,firefox \
REPETITIONS=3 \
PREEMPTION_US=10000 \
PERFORMANCE_WORKLOAD=hot-aot-correctness \
EXPERIMENTAL_HOT_AOT=1 \
pnpm measure:firefox-performance
```

The same workload produced exactly 2,194,877 allocations totalling 93,759,960
bytes and one major collection in both browsers. The collection took 20.49 ms
in Chromium and 52.32 ms in Firefox. Direct FFI and idle scheduler boundary
probes were both below 2.2 ms for 100,000 calls in either browser. Neither
garbage collection nor JavaScript/Wasm boundaries can explain a multi-second
runtime gap.

A native Gecko profile can be captured and summarized independently:

```sh
FIREFOX_GECKO_PROFILE_PATH=reports/firefox-gecko-profile.json \
BROWSERS=firefox \
REPETITIONS=2 \
PREEMPTION_US=10000 \
PERFORMANCE_WORKLOAD=hot-aot-correctness \
EXPERIMENTAL_HOT_AOT=1 \
pnpm measure:firefox-performance

pnpm summarize:firefox-profile reports/firefox-gecko-profile.json
```

In the measured compiler-worker profile, 64.4% of leaf samples were directly
in `bjvm_main.wasm.interpret_2`, and 93.6% of samples included that function.
Secondary interpreter helpers such as virtual dispatch and frame creation made
up most of the remaining hot leaves. This places the bottleneck in Firefox's
execution of the monolithic Wasm interpreter, rather than in the browser host.

The Java-level profile also executed the exact same bytecode count and method
invocation count in Chromium and Firefox. A first profile-guided experiment
cached one repeated generated-AOT classification at rewritten call sites. It
made Firefox approximately 2–3% slower in the paired benchmark, so it was
reverted.

The Java profile also identifies where a method tier can remove the most work.
On the compiler workload, `aload` and `iload` alone account for approximately
38% of the 89 million remaining interpreted bytecodes. The five hottest
remaining methods account for approximately 18%:

1. `com.sun.tools.javac.util.Convert.utf2chars`
2. `jdk.internal.util.Preconditions.checkIndex`
3. `java.lang.StringLatin1.charAt`
4. `java.lang.StringLatin1.lastIndexOf`
5. `java.lang.StringLatin1.replace`

The existing default-off generated-method experiment is a useful causal
control. Enabling it removed 32.0 million of 121.1 million profiled bytecodes
(26.4%) and reduced the profiled Firefox compile from 5.98 s to 4.66 s (22%).
On the paired correctness workload it reduced warm Firefox `javac` from
3.85–4.52 s to 3.27–3.54 s and warm execution from 4.44–5.07 s to
3.56–3.60 s. Chromium improved as well. This is the first tested intervention
that removes a large fraction of the Firefox cost instead of rearranging it.

A subsequent pinned leaf-method slice added generated bodies for
`StringLatin1.charAt`, the single-character `StringLatin1.lastIndexOf`, and
javac's no-call `Convert.chars2utf`. Against the exact preceding AOT artifact,
Firefox's median warm correctness-workload compilation fell from 3.75 s to
3.35 s (10.66%); Chromium fell from 1.06 s to 0.95 s (10.82%). The three
methods added 1,045 bytes of Wasm. All four browsers matched the same oracle,
with 4,630,566 successful generated calls, five deliberate fallbacks, and zero
generated exceptions. Both the enabled and disabled permanent release
matrices passed 108 / 108 cases.

This follow-up also establishes the current boundary. The pinned JDK 23
`Convert.utf2chars` implementation is not a simple UTF loop: it calls
validation policy, constructs javac exceptions, and contains sixteen call
sites. The other leading methods allocate, compose nested Java calls, read
reference fields, or carry exception tables. Adding them as manual C
shortcuts would begin duplicating JVM or JDK semantics. The retained
measurements and exact stopping criteria are in
`docs/hot-path-exploration.md`.

## Conclusion

Firefox spends more time executing the same interpreted Java compiler work.
Reducing host crossings, changing timer mechanisms, changing the portable
dispatcher, partitioning the dispatcher, and Firefox tier controls do not
account for the gap. Allocation and garbage collection are also not the
dominant cost. Reaching the approximately 500 ms goal requires moving hot
`javac` methods out of the current interpreter path. Dispatcher rearrangement
did not help, while removing interpreted bytecodes did.

The retained generated-method experiment is therefore the correct shape for
continued optimization:

1. hot-method profiling for the compiler workload,
2. a small supported bytecode subset,
3. interpreter fallback for unsupported methods,
4. execution-scope cleanup and cancellation ownership,
5. the full browser correctness matrix before every expansion.

It remains default-off and must not become a Firefox-only semantic shortcut.
The next expansion should add a coherent tier capability, not manually
reimplement one complex JDK method.
