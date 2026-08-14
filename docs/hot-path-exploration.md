# Hot-path exploration

Measured: 2026-07-24

## Status

This is an architecture experiment, not a production commitment. The
profiler and exact-intrinsic experiment are default-off. Their purpose is to
answer whether TraceJVM can become substantially faster without replacing the
whole interpreter or weakening Java compatibility.

## What is hot

A deterministic interpreter counter measured one warm `javac` operation in
Chromium and Firefox. Both browsers executed the same methods and instruction
counts; only wall time differed.

The simple compilation executed:

- 75,566,289 interpreted bytecodes;
- 5,044,660 method invocations;
- 4,913 distinct methods.

Method concentration was high:

| Methods | Share of interpreted bytecodes |
| --- | ---: |
| Top 5 | 27.4% |
| Top 10 | 41.6% |
| Top 25 | 63.5% |
| Top 50 | 75.8% |
| Top 100 | 87.3% |

The two hottest methods were
`jdk.internal.util.ArraysSupport.unsignedHashCode` and
`java.lang.StringLatin1.equals`. Together they represented approximately
15.3% of the simple compilation's interpreted bytecodes.

The instruction mix is concentrated too:

| Instruction kinds | Share of interpreted bytecodes |
| --- | ---: |
| Top 5 | 51.4% |
| Top 10 | 66.4% |
| Top 20 | 83.7% |
| Top 40 | 96.6% |

The leading operations are local loads, reference loads, integer constants,
returns, branches, byte-array loads, local stores, increments, resolved calls,
and field reads. Allocation and explicit exception/type/monitor operations are
rare in the executed stream, although implicit Java exceptions from arrays,
fields, and calls still have to be preserved.

## Stability across source shapes

The profiler was repeated for four warm compiler workloads:

1. a tiny class;
2. generics, records, lambdas, and streams;
3. records, sealed types, and pattern switches;
4. seventeen source files compiled together.

The hot set remained stable:

- 7 of the top 10 methods appeared in the top 10 of all four workloads;
- 17 of the top 25 appeared in the top 25 of all four;
- 35 of the top 50 appeared in the top 50 of all four;
- 77 of the top 100 appeared in the top 100 of all four.

The two hottest methods remained first and second in every workload, at
approximately 13% combined. This is compiler/platform behavior, not a
Hello-World-only artifact.

## How small can a compiled subset be?

Every observed method was classified by its static bytecode shape. The
classification records allocation, direct and dynamic calls, fields, arrays,
explicit throws, monitors, switches, type checks, floating-point and wide
values, division, synchronization, and exception tables.

Across the four workloads:

| Conservative subset | Executed bytecodes covered |
| --- | ---: |
| Pure locals, constants, arithmetic, branches, and returns | 3.8–4.2% |
| No-call methods, adding field and array access | 25.7–27.7% |
| Adding resolved direct calls, but no dynamic calls or hard control features | 58.9–68.5% |

This rules out an overly small arithmetic-only tier: it would not move the
product enough. A useful first tier must implement Java array and field
semantics, including null checks, bounds checks, exception delivery, and GC
root safety. Supporting resolved direct calls later roughly doubles the
reachable share.

It also shows that a baseline compiler does not initially need the entire JVM
instruction set. Dynamic dispatch, monitors, complex exception tables, and
less common numeric operations can fall back to the interpreter.

## Exact-intrinsic proof

A default-off experiment replaced the two hottest resolved call sites with
exact TraceJVM instructions implementing the pinned OpenJDK 23 behavior. It
did not perform name checks in the steady-state dispatcher.

Ten-run A/B results:

| Browser | Baseline warm median | Experiment warm median | Improvement |
| --- | ---: | ---: | ---: |
| Chromium | 1,086 ms | 925 ms | 14.9% |
| Firefox | 2,728 ms | 2,370 ms | 13.1% |

Cold compilation improved by approximately 17% in both browsers. Removing
roughly 15% of interpreted bytecodes therefore produced a nearly proportional
wall-time improvement. The hot-path premise is real.

The experiment does **not** establish hand-written intrinsics as the final
architecture. A large hand-maintained catalog would duplicate OpenJDK
implementation details and create version-upgrade risk.

## Candidate directions

### 1. Generated, version-pinned intrinsics

Generate implementations for a deliberately small set of pure OpenJDK 23
platform methods. Validate them against the pinned native JDK with randomized
inputs and exception cases.

This is the shortest path to additional Firefox relief, but remains tied to a
specific OpenJDK image. It is appropriate for a small set of unusually
valuable primitives, not hundreds of methods.

### 2. Profile-guided build-time AOT

Compile a supported subset of bytecode from the pinned platform/compiler image
into TraceJVM's main Wasm module during the runtime build. Unsupported methods
remain interpreted.

This is the most promising next exploration:

- the hot compiler/platform methods are known before deployment;
- no browser-side `WebAssembly.compile` is required;
- there is no per-session compilation pause;
- CSP and Safari behavior remain simpler;
- generated code can be tested against the exact OpenJDK 23 oracle;
- user classes can remain interpreted until the tier is mature.

A first milestone should compile no-call leaf methods, in this order:

1. pure integer methods such as `Byte.toUnsignedInt`;
2. byte-array loops such as `StringLatin1.equals`;
3. simple field readers such as `String.isLatin1`;
4. additional stable no-call leaves selected by measured payoff.

This sequence forces the compiler to establish integer semantics, then array
checks and GC safety, then object-field semantics. It should not add direct
calls until those foundations are proven.

### 3. Runtime JIT

A runtime tier could eventually optimize user code or workload-specific hot
methods. It is not the first experiment to pursue.

The dormant b-jvm `dumb_jit` is not a usable base as-is. Critical frame,
deoptimization, exception, stack/local, and GC functions are stubs, JIT entry
is disabled, and its dynamic Wasm instantiation path contains Node-only
`require("fs")` and `process.exit` calls. Reusing its control-flow and Wasm
builder ideas may be useful, but enabling it is not a small patch.

## Correctness boundaries

Any generated tier must preserve observable OpenJDK 23 behavior:

- signed overflow, shifts, conversions, and division traps;
- null and bounds checks at the same operations;
- exact exception classes and catchability by caller frames;
- class initialization and resolution order;
- object movement and GC roots at every safepoint;
- cancellation and TraceJVM scheduler preemption;
- interpreter fallback without partially mutating a frame;
- static state and Worker retirement/isolation behavior.

The compiler should reject unsupported methods before execution rather than
attempt partial compilation with an unproven deoptimization path.

## Next experiment and decision gate

Build a default-off, build-time AOT prototype for the first three milestone
methods. It should be generated from bytecode shape rather than selected by
hard-coded Java method names, while an allowlist controls which pinned image
methods are admitted.

Continue only if the prototype:

1. passes randomized differential tests against pinned native OpenJDK 23;
2. passes the complete four-browser TraceJVM release gate;
3. retains interpreter fallback for every unsupported method;
4. improves representative warm `javac` by at least 10% in Firefox and does
   not regress Chromium or WebKit;
5. adds no browser-side dynamic-code or CSP requirement;
6. has a measured, bounded payload and memory cost.

Until that gate passes, the exact intrinsics and profiler remain experimental
evidence, not the stable runtime design.

## First generated-AOT result

Measured on 2026-07-24, the first build-time prototype clears the narrow
continuation gate above. It does **not** make AOT a stable or default-on
TraceJVM feature.

The generator uses the Java 23 ClassFile API to parse the exact classes from
the pinned OpenJDK image. An explicit allowlist chooses three methods, while
their C bodies, control flow, operand-stack heights, null checks, bounds
checks, integer operations, and returns are generated from bytecode:

- `Byte.toUnsignedInt(B)I`;
- `StringLatin1.equals([B[B)Z`;
- `ArraysSupport.unsignedHashCode(I[BII)I`.

Unsupported shapes are rejected during the build. Calls above the bounded
loop budget fall back before generated execution begins. At runtime, only
resolved static call sites admitted by the generator are patched to the AOT
handler; ordinary Java calls do not pay an AOT classification or dispatch
cost. Exact counters are independently opt-in so telemetry does not distort
the measured path.

The deterministic oracle exhausts all byte values and runs 2,000 randomized
Latin-1 equality/hash cases. Its output matched pinned native OpenJDK 23 in all
four release browsers:

| Browser | AOT successes | Fallbacks | Exceptions | Oracle |
| --- | ---: | ---: | ---: | --- |
| Chromium | 730,199 | 2 | 0 | exact match |
| Firefox | 730,199 | 2 | 0 | exact match |
| WebKit | 730,199 | 2 | 0 | exact match |
| WebKit, iPad emulation | 730,199 | 2 | 0 | exact match |

Both configurations then passed the complete permanent release matrix:

- AOT enabled: 108 / 108 cases;
- AOT omitted: 108 / 108 cases.

The paired seven-run `javac` workload used a 10 ms scheduler-preemption
frequency. Warm values are medians after the first execution:

| Browser | Baseline warm `javac` | Generated AOT | Improvement |
| --- | ---: | ---: | ---: |
| Chromium | 615.83 ms | 559.70 ms | 9.11% |
| Firefox | 2,511.64 ms | 2,224.60 ms | 11.43% |
| WebKit | 577.02 ms | 529.92 ms | 8.16% |
| WebKit, iPad emulation | 573.36 ms | 520.54 ms | 9.21% |

Cold compilation improved by 9.08–11.22% across the same browsers. The Wasm
payload delta against a build with generated AOT omitted was 895 bytes
(0.12%). Chromium process-RSS sampling did not show a memory increase: the
enabled sample was lower than baseline at runtime and peak, which should be
treated as measurement noise rather than a memory-saving claim. The generated
path allocates no runtime heap structures, and its cached method
classification is excluded from no-AOT builds.

The decisive optimization was call-site patching. A first version checked the
AOT classifier from every resolved Java call and improved Firefox by only
8.59%. Rewriting only admitted call sites raised the paired result above the
10% gate. Converting the generated operand stack from a dynamic index to
statically analyzed scalar slots improved compiler structure and
auditability, but did not materially change this three-method benchmark.

### What this result permits

This result permits expansion of the experimental compiler and broader
differential testing. It does not permit enabling `experiments.hotAot` by
default, removing the interpreter path, or treating three library methods as a
general compiled tier.

The next useful exploration is profile-guided allowlist growth with the same
rules: generated bytecode semantics, static call-site admission, complete
native differential coverage, bounded cancellation behavior, and paired
cross-browser measurements. Array-loop optimization and verified direct-call
inlining are higher-value next compiler capabilities than a runtime JIT.

## Second generated-AOT result

The second default-off slice tested whether the first result scaled beyond
three unusually favorable methods. The cross-workload profile selected three
more static OpenJDK 23 methods:

- `StringLatin1.indexOf([BI[BII)I`;
- `StringLatin1.lastIndexOf([BI[BII)I`;
- `StringUTF16.compress([CI[BII)I`.

These methods account for approximately 18 million interpreted bytecodes
across the four profiling workloads. Supporting them widened the generator
with reusable bytecode semantics rather than method-specific C:

- signed-wraparound integer subtraction;
- byte and char primitive-array loads;
- byte and char primitive-array stores;
- `i2b` and `i2c` narrowing conversions;
- Java null and array-bounds exception delivery at each array operation.

The deterministic oracle now includes randomized forward and reverse
substring search, successful Latin-1 compression, and partial compression
where a non-Latin-1 character forces UTF-16. Its native OpenJDK 23 digest is
`29c7dd752f15badb`. All four release browsers matched it exactly:

| Browser | AOT successes | Fallbacks | Exceptions | Oracle |
| --- | ---: | ---: | ---: | --- |
| Chromium | 1,015,194 | 2 | 0 | exact match |
| Firefox | 1,015,194 | 2 | 0 | exact match |
| WebKit | 1,015,194 | 2 | 0 | exact match |
| WebKit, iPad emulation | 1,015,194 | 2 | 0 | exact match |

The two fallbacks remain the deliberately oversized 5,000-element cases. No
new method fell back or raised an exception in the oracle.

The complete permanent matrix passed with the widened experiment enabled
(108 / 108 cases). The same widened runtime also passed with the experiment
disabled (108 / 108 cases), preserving the default interpreter path.

Seven-run paired measurements against the same Wasm artifact, with the
experiment disabled for the baseline, produced:

| Browser | Baseline warm `javac` | Six-method AOT | Improvement |
| --- | ---: | ---: | ---: |
| Chromium | 591.94 ms | 503.62 ms | 14.92% |
| Firefox | 2,468.55 ms | 2,315.28 ms | 6.21% |
| WebKit | 517.84 ms | 476.31 ms | 8.02% |
| WebKit, iPad emulation | 520.60 ms | 460.02 ms | 11.64% |

Firefox exhibited substantial process-to-process variance. A separate
nine-run immediate A/B measured a warm median of 2,725.06 ms without AOT and
2,354.76 ms with AOT, a 13.59% improvement; cold compilation improved from
9,240.76 ms to 8,290.32 ms. The honest conclusion is that Firefox gains are
repeatable but the current short benchmark is not precise enough to claim one
single percentage. Longer alternating trials should replace one-process A/B
before any default-on decision.

The generated Wasm is 728,658 bytes versus 726,413 bytes with generated AOT
omitted: a 2,245-byte or 0.31% cost. The generated methods allocate no runtime
heap structures. One-sample Chromium process-RSS measurements varied by tens
of megabytes in both directions across runs despite identical Wasm heap
configuration, so they establish no measurable AOT-specific memory cost or
saving. A paired in-process memory benchmark is still required before a
default-on decision.

This second slice strengthens the build-time AOT direction: a generic
array-loop subset produces additional gains without browser-side compilation
or a deoptimization mechanism. It still does not justify enabling the
experiment by default. The next architectural fork is whether to add verified
direct static calls and instance-field reads. Both expose materially more of
the stable hot set, but also introduce class-initialization, object-layout,
GC-root, and callee-exception obligations that the current leaf-only subset
deliberately avoids.

## Static-leaf boundary result

The third default-off slice deliberately exhausted the remaining high-value
static, no-call leaves that fit the established integer/array contract before
crossing into object fields or nested Java calls. It added eleven generated
OpenJDK 23 methods:

- `StringLatin1.indexOfChar([BIII)I`;
- `StringCoding.countPositives([BII)I`;
- integer `Math.min` and `Math.max`;
- `Character.charCount` and `Character.isSurrogate`;
- the `char` and `int` overloads of `StringLatin1.canEncode`;
- `Integer.bitCount` and `Integer.stringSize`;
- `StringUTF16.coderFromArrayLen`.

Together these methods account for 8,501,835 interpreted bytecodes across the
four profiling workloads. The generator gained reusable unsigned-right-shift
and wrapping-integer-negation semantics. Its stack analysis now models unary
operators separately from binary operators; an initial incorrect binary
classification of `ineg` was rejected at generation time before C or Wasm was
produced.

The expanded oracle checks forward and reverse character search, signed and
out-of-Latin-1 search values, randomized integer minima, maxima and bit counts,
surrogate boundaries, integer rendering sizes, UTF-8 positive-byte runs, and
UTF-16 coder selection. Its pinned native OpenJDK 23 digest is
`efb9182773d2bcbf`. Every release browser matched exactly:

| Browser | AOT successes | Fallbacks | Exceptions | Oracle |
| --- | ---: | ---: | ---: | --- |
| Chromium | 1,344,415 | 3 | 0 | exact match |
| Firefox | 1,344,415 | 3 | 0 | exact match |
| WebKit | 1,344,415 | 3 | 0 | exact match |
| WebKit, iPad emulation | 1,344,415 | 3 | 0 | exact match |

The three fallbacks per execution are deliberately oversized array/string
cases. The complete permanent release matrix passed with all seventeen
generated methods enabled (108 / 108) and with the experiment disabled
(108 / 108).

The retained paired seven-run reports are
`reports/hot-aot-static-leaf-baseline.json` and
`reports/hot-aot-static-leaf-enabled.json`. Warm values below are medians after
the first compilation:

| Browser | Baseline warm `javac` | Seventeen-method AOT | Improvement |
| --- | ---: | ---: | ---: |
| Chromium | 1,119.46 ms | 972.99 ms | 13.08% |
| Firefox | 4,221.47 ms | 3,581.63 ms | 15.16% |
| WebKit | 1,040.97 ms | 873.79 ms | 16.06% |
| WebKit, iPad emulation | 1,029.78 ms | 855.25 ms | 16.95% |

The AOT Wasm is 730,476 bytes versus 726,413 bytes with generated AOT omitted:
a 4,063-byte or 0.56% cost. Generated execution still allocates no runtime
heap structures.

This marks the useful boundary of the current static-leaf subset. More
allowlist accumulation is no longer the right next experiment:

- `String.isLatin1` and `String.coder`, the two largest remaining stable
  no-call leaves, account for 10,389,149 and 5,922,995 bytecodes respectively
  but require verified instance-field semantics;
- `Convert.chars2utf` accounts for 4,997,286 bytecodes but lives in
  `jdk.compiler`, outside the generator's current `java.base` input, and needs
  a wider integer opcode subset;
- `StringLatin1.inflate` accounts for 3,684,511 bytecodes but requires
  generated `void` returns;
- `Reference.reachabilityFence` must not be compiled as an apparent no-op:
  its VM reachability contract is more important than its empty bytecode body.

The next focused exploration should therefore be instance-field reads, starting
with the two `String` accessors. It must resolve fields from the pinned class
metadata rather than hard-code offsets, preserve null behavior, and prove that
object references remain valid under the engine's GC model. Direct calls should
remain a later milestone because they add callee exceptions, class
initialization, scheduler, and nested-frame obligations.

## Instance-field boundary result

The fourth default-off slice crossed the instance-method and field-read
boundary for the two largest remaining stable leaves:

- `String.coder()B`;
- `String.isLatin1()Z`.

Across the four profiling workloads these methods represented approximately
16.3 million interpreted bytecodes. The implementation deliberately keeps JVM
dispatch authoritative. `invokevirtual`, `invokespecial`, or interface
dispatch first validates the receiver and resolves the exact target method.
Only then may the generated body execute. A null receiver therefore fails at
the same invocation boundary as the interpreter path, and a polymorphic site
still selects its target through the ordinary vtable or itable.

The generator now supports `getstatic` and `getfield` for byte and boolean
fields. It embeds symbolic field names and descriptors, never object-layout
offsets. TraceJVM resolves those symbols against the linked declaring class and
caches the resulting `cp_field` metadata once per class. The generated body
contains no allocation, call, or scheduler point, so its receiver reference
cannot be relocated during the field read. Static `COMPACT_STRINGS` and
instance `coder` values are read through the engine's existing field
representation.

The expanded oracle alternates ASCII, Latin-1, UTF-16, and arbitrary UTF-16
code units, including unpaired surrogates, and checks public string behavior
that repeatedly dispatches through both accessors. Its pinned native OpenJDK
23 digest is `23d5504fcb49a9a7`. Every release browser matched it exactly:

| Browser | Total AOT successes | `String.coder` | `String.isLatin1` | Fallbacks | Exceptions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 3,994,066 | 1,711,344 | 879,614 | 3 | 0 |
| Firefox | 3,994,066 | 1,711,344 | 879,614 | 3 | 0 |
| WebKit | 3,994,066 | 1,711,344 | 879,614 | 3 | 0 |
| WebKit, iPad emulation | 3,994,066 | 1,711,344 | 879,614 | 3 | 0 |

The retained oracle report is
`reports/hot-aot-instance-field-oracle.json`. The complete permanent release
matrix also passed with all nineteen generated methods enabled (108 / 108) and
with the experiment disabled (108 / 108). Those reports are
`reports/hot-aot-instance-field-release-enabled.json` and
`reports/hot-aot-instance-field-release-disabled.json`.

Seven-run paired measurements are retained in
`reports/hot-aot-instance-field-baseline.json` and
`reports/hot-aot-instance-field-enabled.json`. Medians include the first
compilation because each seven-run sequence has an odd sample count:

| Browser | Baseline `javac` | Nineteen-method AOT | Improvement |
| --- | ---: | ---: | ---: |
| Chromium | 1,105.95 ms | 995.52 ms | 9.98% |
| Firefox | 4,304.10 ms | 3,697.12 ms | 14.10% |
| WebKit | 1,035.68 ms | 919.16 ms | 11.25% |
| WebKit, iPad emulation | 1,026.76 ms | 902.14 ms | 12.14% |

The string-heavy oracle's execution median improved by 19.50% in Firefox and
29.28–30.28% in the other browsers. The generated Wasm is 732,812 bytes,
6,399 bytes or 0.88% above the 726,413-byte build with generated AOT omitted.
This field slice itself added 2,336 bytes over the seventeen-method build.
Runtime metadata adds two optional field pointers per loaded class, not per
method, and generated execution still allocates no heap objects. A paired
one-sample Chromium RSS check measured a 9.2 MB lower peak with AOT enabled;
as with earlier process-level samples, that is noise rather than a claimed
memory saving, but it exposes no measurable regression. The raw samples are
`reports/hot-aot-instance-field-memory-baseline.json` and
`reports/hot-aot-instance-field-memory-enabled.json`.

This is a positive continuation result, not a default-on decision. It proves
that a generated body can sit below normal instance dispatch and above
runtime-resolved field metadata without taking ownership of either. The next
candidate should remain bounded. Direct-call support still requires explicit
class-initialization, callee-exception, scheduler, and nested-frame semantics.

## Pinned leaf-method expansion

A fifth default-off slice followed the remaining Firefox profile down to the
next three methods whose successful paths can be generated without taking
ownership of Java calls, allocation, or exception construction:

- `StringLatin1.charAt(byte[], int)`;
- `StringLatin1.lastIndexOf(byte[], int, int)`;
- javac's `Convert.chars2utf(char[], int, byte[], int, int)`.

This slice deliberately rejected the larger
`Convert.utf2chars(byte[], int, char[], int, int, Validation)` candidate.
The pinned JDK 23 implementation invokes validation policy, constructs
`InvalidUtfException`, and has sixteen call sites. Recreating that logic in C
would duplicate javac semantics rather than compile a bounded bytecode subset.

`StringLatin1.charAt` keeps observable exception behavior in Java. Its
generated valid path performs the pinned bounds check and byte load. An invalid
index returns `HOT_AOT_FALLBACK` before the load so the original JDK 23
`String.checkIndex` path remains responsible for the exact exception type and
message. The generator recognizes the pure integer meaning of
`StringLatin1.canEncode(int)` and `Math.min(int, int)` while compiling the
single-character `lastIndexOf`; this is build-time inlining, not general nested
Java-call support. `Convert.chars2utf` has no calls or exception handlers and
uses only the generator's checked array and integer subset.

The expanded correctness oracle includes valid Latin-1 reads, both invalid
index boundaries, reverse searches, and compilation through the javac
conversion path. All four browsers produced the exact digest
`78150c8d9f71fa61`. Each browser recorded 4,630,566 successful generated calls,
five deliberate fallbacks, and zero generated exceptions. The new methods
contributed the same counts in every browser:

| Generated method | Successful calls |
| --- | ---: |
| `StringLatin1.charAt` | 630,399 |
| `StringLatin1.lastIndexOf(byte[], int, int)` | 19,400 |
| `Convert.chars2utf` | 3,353 |

The retained oracle is
`reports/hot-aot-leaf-expansion-oracle.json`. The complete permanent release
matrix passed with all 22 generated methods enabled (108 / 108) and with the
experiment disabled (108 / 108). Those reports are
`reports/hot-aot-leaf-expansion-release-enabled.json` and
`reports/hot-aot-leaf-expansion-release-disabled.json`.

Three-run paired measurements against the exact preceding nineteen-method Wasm
are retained in `reports/hot-aot-leaf-expansion-baseline.json` and
`reports/hot-aot-leaf-expansion-enabled.json`:

| Browser | Nineteen-method AOT | Twenty-two-method AOT | Additional improvement |
| --- | ---: | ---: | ---: |
| Chromium | 1,059.63 ms | 945.00 ms | 10.82% |
| Firefox | 3,749.08 ms | 3,349.58 ms | 10.66% |

The string-heavy execution median improved from 659.40 ms to 618.00 ms in
Chromium and from 3,656.20 ms to 3,552.70 ms in Firefox. The final generated
Wasm is 732,956 bytes, 1,045 bytes above the preceding artifact and 6,543 bytes
(0.90%) above the build with generated AOT omitted.

This result confirms that Firefox's largest removable loss is distributed
across interpreted Java methods rather than concentrated in one dispatcher or
browser setting. The remaining leaders cross a different boundary:
`Convert.utf2chars` owns validation and exception construction;
`JrtPath.normalize` and `StringLatin1.replace` allocate and call other Java
methods; public `String.charAt` requires reference-field and nested-call
composition; `ClassReader.classSigToType` has exception handlers and complex
object behavior. None should be added by one-off C reimplementation. Further
work should first define the corresponding generated-tier capability and its
fallback, lifecycle, and differential-oracle contract.
