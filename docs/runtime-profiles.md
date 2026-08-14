# Runtime profiles

TraceJVM runtime capabilities are explicit. A consumer selects one profile and
provides the corresponding asset URL. Missing assets fail initialization. The
engine never falls back to a smaller profile because doing so would turn a
provisioning error into misleading compiler or class-loading failures.

## Profiles

- `core` is the default and contains `java.base`. It is intended for algorithmic
  code and ordinary CLI programs.
- `server` adds the standard headless APIs used by HTTP services, logging,
  management, naming, SQL, XML, instrumentation, and unsupported compatibility
  APIs commonly used by frameworks.
- `spring-server` additionally includes `java.desktop` and its transitive
  dependencies because Spring-style bean introspection uses `java.beans`.
  Including those class libraries does not mean TraceJVM supports AWT, Swing,
  graphics, audio, or desktop integration.

The exact module lists are pinned in `runtime/manifest.json`.

Each profile also contains a generated package-to-module map. The VM applies
that map when defining bootstrap classes so `java.xml`, `java.logging`, and
other named-module classes do not masquerade as `java.base`. This is required
for reflection and `ServiceLoader` access checks, not merely cosmetic module
metadata.

## Why profiles are separate

The Java compiler needs a platform module image while the VM needs loadable boot
classes. Today those contain much of the same class-library information in two
different formats. That makes a cold Spring-capable Worker materially larger
than a core Worker. The checked-in measurement report records the cost and is
regenerated from built assets with:

```sh
node scripts/report-runtime-profiles.mjs docs/runtime-profile-measurement.json
```

This duplication is a future optimization target. It must not be removed by
weakening compiler semantics or making the compiler see a different Java API
surface from the runtime.

The current 64 MB-heap Chromium process-RSS measurement is:

| Profile | Cold assets | Runtime over page | Peak over page |
| --- | ---: | ---: | ---: |
| `core` | 29.2 MB | 212.6 MB | 271.1 MB |
| `server` | 42.2 MB | 219.5 MB | 321.4 MB |
| `spring-server` | 60.7 MB | 282.0 MB | 382.5 MB |

RSS includes Chromium allocation behavior and is therefore a comparative
measurement, not an exact per-user memory bill. The raw snapshots and Worker
termination retention are in `docs/runtime-profile-memory.json`. Reproduce the
measurement with:

```sh
pnpm build
pnpm build:test-browser
node tests/browser/measure-profile-memory.mjs docs/runtime-profile-memory.json
```

## Compatibility honesty

Selecting a profile means its classes are provisioned for compilation and
execution. It does not mean every native boundary in every module is complete.
Compatibility claims are earned by profile-specific smoke tests and upstream
OpenJDK coverage. Unsupported GUI behavior is never represented as a silent
no-op.
