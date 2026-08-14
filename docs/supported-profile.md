# Supported Java profile

TraceJVM's first release target is the
`openjdk-23-core-browser-v1` profile recorded in
`compatibility/openjdk/release-profile.json`. The machine-readable profile is
the compatibility contract. This page explains its boundaries.

## What the profile promises

The profile compiles ordinary Java 23 source with the pinned OpenJDK
`23.0.2+7` compiler and executes the emitted Java 23 class files in a browser
Worker. It supports standard `main(String[])` programs, source trees with
multiple files and packages, program arguments, system properties, standard
output and error capture, and embedder-provided in-memory files and class
paths.

The runtime image is the `core` profile: `java.base` plus the compiler modules
needed by browser-side `javac`. Chromium, Firefox, WebKit, and WebKit with iPad
emulation are release-gated. A physical iPad is useful product evidence but is
not represented by browser emulation and is tracked separately.

The public API defaults to safe isolation. Abort terminates the Worker. A
completed run may reuse a warm VM only after its execution scope restores the
covered process state. Any application-created thread taints the scope and
causes the default Worker client to retire the Worker.

## What the profile does not promise

The profile does not claim full Java SE compatibility. It excludes preview
features, JNI, unimplemented OpenJDK native boundaries, GUI and audio stacks,
operating-system process creation, unrestricted access to the host filesystem
or network, embedder-provided or interactive standard input, and modules
outside `java.base`.

The larger `server` and `spring-server` images prove that additional class
libraries can be provisioned. They remain experimental until their native
boundaries and representative upstream tests earn a separate compatibility
profile. Merely shipping a class in an image is not a compatibility claim.

## How compatibility is decided

Pinned Eclipse Temurin/OpenJDK `23.0.2+7` is the behavioral oracle. Discovery
campaigns compile the same source with the native and browser compilers,
compare class-file hashes, then compare exit status and deterministic
stdout/stderr. Self-verifying performance tests and environment-dump tests
compare class files and exit status but not wall-clock, object-identity, or
host-property text. A test that reports its own internal deadline as
incomplete remains a timeout rather than a pass.

Every non-pass must be one of:

- `tracejvm-semantic-defect`
- `missing-runtime-module`
- `missing-native`
- `unsupported-browser-capability`
- `test-infrastructure`
- `timeout`

Only tests promoted into the checked-in manifest are release gates. Discovery
campaigns intentionally include unsupported and non-standalone upstream tests
so the measured boundary cannot collapse into a curated set of favorable
examples.
