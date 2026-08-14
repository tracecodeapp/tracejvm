# Engine provenance

The initial TraceJVM interpreter, garbage collector, scheduler, object model,
and class-file implementation were imported from:

- project: b-jvm
- repository: <https://github.com/anematode/b-jvm>
- commit: `3fd56c74656602eb32efefca46f51f074bef6bca`
- license: MIT

This is a pinned, vendored engine snapshot rather than a continuously
synchronized public fork. The import includes TraceJVM's initial Java 23
compatibility changes and is now owned and versioned as part of TraceJVM.
Production builds do not clone or patch an untracked b-jvm checkout.

Generic JVM mechanics belong in this directory. TraceJVM lifecycle, browser
integration, compatibility tooling, runtime images, and the public API live
outside it. Engine changes retain their provenance in this repository and are
validated against the pinned OpenJDK oracle. That boundary lets TraceJVM
replace individual engine subsystems later without making the vendored
snapshot its public architecture.
