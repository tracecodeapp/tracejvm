# Embedding TraceJVM

TraceJVM exposes a host-neutral compile, run, and lifecycle boundary.
Applications integrate through that public boundary rather than adding
product protocols to the VM.

## Verified boundary

The browser integration matrix constructs a workspace-backed host, then:

1. runs `javac -d build src/example/Main.java`;
2. persists the emitted class file into the workspace as a binary file;
3. runs `java -cp build -Dmode=first example.Main hello`;
4. runs the class again without the property;
5. runs a main class that exists only in a workspace JAR;
6. runs the same ordinary compressed JAR through `java -jar`;
7. mutates properties, streams, locale, time zone, thread metadata, interrupt
   state, handlers, and thread-locals;
8. proves those mutations do not cross the process boundary;
9. creates an application child thread and proves the Worker is marked for
   hard retirement;
10. invokes a production source-rewriting pipeline through its ordinary JAR;
11. compiles the rewritten source with its ordinary helper JAR;
12. captures raw call, line, return, and snapshot events from `TraceHooks`;
13. reconstructs those events outside the VM; and
14. verifies Java 23 `ThreadLocal`, `InheritableThreadLocal`, and
    `WeakReference` behavior used by that tracing path.

This passes in Chromium, Firefox, and WebKit with the actual TraceJVM Worker.
The complete semantic-instrumentation matrix is also a permanent gate:
all 84 Java-applicable fixtures pass through TraceJVM in Chromium, Firefox,
and WebKit with the existing assertions unchanged. The gate covers emitted
events, snapshots, access provenance, calls and returns, mutations, line
sequences, output, and exceptions.

The provider differential additionally runs the real CheerpJ 4.2 browser
worker and TraceJVM against all 84 fixtures in Chromium. It requires exact
equality for the raw `TraceHooks` arrays, reconstructed frontend traces, and
returned outputs. The current result is 84/84 exact matches with zero missing
or differing fixtures. CheerpJ uses bounded fresh-VM chunks in this semantic
gate because an unbounded warm CheerpJ session reproducibly aborts at fixture
70; the same fixture passes when isolated. TraceJVM completes the unbounded
84-fixture run.

The semantic-trace provider keeps dynamic values inline in the generated
source through the Java worker's explicit internal `inline-source` input
transport. The existing CheerpJ path may materialize those values as virtual
filesystem JSON to maximize compile reuse, but TraceJVM does not yet expose the
generic workspace filesystem host required to reproduce that transport. This
is an intentional adapter boundary, not a silent fallback or a weakened
semantic assertion.

## Ownership

TraceJVM owns:

- Java 23 compilation and bytecode execution;
- class and JAR classpaths;
- process arguments and process-scoped Java system properties;
- execution-scope restoration and isolation reporting;
- Worker cancellation, taint-driven retirement, and streamed output.

The consumer adapter owns:

- `javac` and `java` argument parsing;
- mapping workspace paths to source/classpath entries;
- persisting compiler artifacts;
- mapping Java outcomes onto process exit and signal conventions;
- TraceKernel event and lifecycle presentation.

Application tracing is a separate embedder concern. The verified integration
instruments source before compilation, includes ordinary helper classes on the
classpath, and reconstructs emitted events outside TraceJVM. TraceJVM does not
gain a trace request type or an application-specific event emitter.

Downstream application corpora provide additional evidence:

- direct execution: 80/80 Java programs and 1,232/1,232 authored cases in
  Chromium;
- instrumented execution: 200/200 programs and 2,352/2,352 authored cases in
  Chromium;
- representative consumer shard: 7 programs and 96/96 cases in Chromium,
  Firefox, WebKit, and WebKit with iPad emulation;
- semantic instrumentation: 84/84 Java-applicable fixtures with unchanged
  assertions in Chromium, Firefox, and WebKit;
- hosted multi-file applications: no authored Java corpus exists yet, so
  coverage remains explicitly zero.

## Hosted boundary

A process-style adapter keeps operating-system policy in the host while
routing Java's operating-system boundaries through TraceJVM's generic
process-scoped host port.
Ordinary Java file and random-access APIs use authoritative TKFS; standard
descriptors and process pipes are kernel-owned; sockets and selectors use the
session network namespace; `ProcessBuilder`, `ProcessHandle`, environment
queries, and watch services use the kernel process and descriptor tables.

Controls without a Java SE equivalent live in the standalone
`io.tracecode.tracekernel.TraceKernel` API artifact. It exposes process
identity, watchdog arm/pet/disarm/status, `setsid`, `setpgid`, `tcgetpgrp`, and
`tcsetpgrp`. The artifact contains only typed Java wrappers and native
declarations. TraceJVM dispatches them through the generic host envelope;
TraceKernel remains the implementation and authority.

Unsupported capabilities fail visibly. Standalone TraceJVM does not silently
invent a filesystem, network namespace, watchdog, process group, or terminal
policy when no host is configured.

## Warm compiler and disposable runners

`TraceJVMCompilerWorkerClient` owns only a long-lived TeaVM compiler.
`TraceJVMWorkerClient` owns one runner Worker and its process-bound host port.
Terminating that runner releases its VM and native host bookkeeping while the
compiler remains warm.

Inside an embedder-owned provider Worker, `TraceJVMRunnerHost` can instead
retain the immutable JDK/Wasm substrate and lease disposable JVMs. It has no
compiler API; the embedder explicitly pairs it with `TraceJVMCompiler`.

TraceKernel decides admission, process lifetime, cancellation, and retirement.
TraceJVM implements the physical warm/replace capability. Durable files are
provisioned through each runner's bound TraceKernel process. Multiple runner
Workers may be active concurrently; their PIDs, working directories, host
calls, Java heaps, output routes, and scratch namespaces remain distinct.
A hard runner abort terminates only that runner Worker. A compiler abort
terminates and lazily reconstructs only the compiler Worker.
