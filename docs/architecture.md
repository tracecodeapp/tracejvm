# TraceJVM architecture

## Boundary

TraceJVM is an embeddable Java toolchain, not an application runtime.

```text
Application adapter             Process-style host adapter
        |                                  |
        +--------- generic TraceJVM API ----+
                            |
                  Worker lifecycle host
                    /               \
         TeaVM-javac compiler     process lease
          source -> classfiles         |
                              TraceJVM runner (Wasm)
                                       |
                              explicit host services
```

The compiler accepts source and classpath inputs and returns ordinary
classfiles. The runner accepts only compiled classfiles, a main class, and
process arguments. There is no combined role or source-capable VM. The runtime
host may coordinate both components, but capability ownership remains
separate.

## Effect boundary

TraceJVM uses Effect directly. It does not import a consumer framework or
inherit an application runtime abstraction from one.

- `TraceJVMCompiler.initializeEffect` and `compileEffect` are the authoritative
  compiler operations.
- `TraceJVMEngine.initializeEffect` and `runEffect` are the authoritative
  runner operations.
- VM startup, Worker transport, interruption, and teardown failures use tagged
  error values.
- Java compiler diagnostics and uncaught Java exceptions are execution
  outcomes, not Effect failures.
- `TraceJVMEngineService` and `TraceJVMWorkerService` are `Context.Tag`
  services with scoped `Layer` constructors.
- Scope finalizers dispose the in-process engine or terminate the Worker even
  when acquisition is followed by failure or interruption.
- Promise methods delegate through a single Exit-unwrapping boundary so
  non-Effect consumers receive the original tagged failure.

Consumer adapters may compose these services into their own layers. TraceJVM
does not own those adapters.

## Ownership

TraceJVM owns:

- JVM bytecode execution and Java language semantics
- OpenJDK source-to-classfile compilation through TeaVM-javac
- class loading and application execution scopes
- the Java 23 compiler SDK and runtime class image
- generic compile and run operations across separate components
- stdout/stderr capture primitives
- process-scoped system properties with restoration after every execution
- cancellation and disposal contracts
- compatibility evidence

Consumers own:

- source templates and function invocation ABI
- test-case serialization and result decoding
- source or bytecode instrumentation, probe injection, and trace collection
- consumer-specific event schemas, limits, transport, and reconstruction
- virtual process metadata and exit presentation
- filesystem/environment/network adapters
- product telemetry and policy

## Tracing boundary

TraceJVM does not implement application tracing. Its job is to be a faithful,
fast, browser-native JVM.

An embedder may rewrite source, transform bytecode, or add ordinary helper
classes before passing a program to TraceJVM. TraceJVM executes those classes
without knowing which instructions are probes and without emitting a
consumer-specific event protocol. This keeps instrumentation policy
replaceable and prevents JVM compatibility work from becoming coupled to one
product surface.

VM facilities that are part of normal Java compatibility, such as the
`java.instrument` module in a server profile, are not Trace Mode integration.
They remain governed by OpenJDK behavior.

## Isolation

One TeaVM compiler remains warm independently of runner retirement. Each
runner receives compiled artifacts through an explicit process lease. A runner
may execute multiple operations for one consumer batch, but it never gains a
compiler. This is an optimization, not a complete security boundary: b-jvm
cannot yet fully dispose all VM state.

The browser Worker is therefore the hard lifecycle boundary. Consumers should:

1. create one engine per Worker;
2. serialize operations inside that engine;
3. let the Worker client retire an idle Worker when
   `retirementRecommended` becomes true;
4. terminate the Worker to guarantee disposal or interrupt active execution.

Unsafe long-lived reuse may be offered by a consumer as an explicit mode. It is
not the default contract. `TraceJVMWorkerClient` enforces retirement by default;
`retireAutomatically: false` is the explicit unsafe opt-out.

Application class-loader isolation is only one part of safe reuse. Mutable JVM
process state must also be restored. Around every application entry point,
TraceJVM's execution scope isolates or restores:

- the complete `System` property set and standard streams; applications receive
  non-owning stream wrappers so closing a run-scoped stream cannot close the
  warm host's underlying input or output;
- default locale and time zone;
- thread context class loader, uncaught-exception handlers, name, priority,
  and interrupt state;
- the platform thread's thread-local and inheritable-thread-local maps.

The scope records a monotonic VM thread-creation epoch and compares the live
thread registry before and after the entry point. The epoch detects even a
short-lived child that exits before the entry point returns; the registry lets
the scope interrupt and join children that remain alive. Creating any
application thread currently taints the engine even when cleanup succeeds. A
tainted result sets `hardBoundaryRecommended` and `retirementRecommended`; the
default Worker client terminates that idle Worker before another operation can
reuse it. This conservative retirement preserves safe behavior while
generation-owned threads and blocking-resource cleanup are still incomplete.

Every run returns an isolation report. Browser tests first mutate each covered
piece of process state and then prove a second execution sees the original
values. A separate adversarial case creates a child thread and proves that the
engine is tainted and retired. This makes the current boundary observable
rather than treating fresh class loaders as complete isolation.

The boundary is not yet a security sandbox or a complete Java-process reset.
Environment variables, mounted files, sockets, native handles, and other future
host capabilities must gain their own execution-scope ownership before they
can be safely reused.

## Host extensibility

Host services are capability interfaces, added only when the VM can make their
behavior real. An embedder may provide filesystem, clock, randomness, process,
or networking capabilities as those native boundaries are extracted.

TraceJVM must not add no-op methods to make an interface look complete.
Unsupported behavior stays absent or fails explicitly.

## Compatibility doctrine

OpenJDK tests are the semantic authority. The suite is imported from an exact
upstream revision with original licensing and checksums. TraceJVM-specific
smoke tests cover its browser API, lifecycle, streaming, and transport, but may
not replace upstream semantic evidence.

Compatibility is a ledger:

- **pass** means an unchanged upstream test passed;
- **VM gap** means the test is runnable and exposed a semantic defect;
- **host capability missing** means semantics require an interface TraceJVM has
  not implemented yet;
- **jtreg mode unsupported** means the test requires infrastructure such as a
  native helper, `othervm`, TestNG, or special VM flags.

No category is silently skipped.
