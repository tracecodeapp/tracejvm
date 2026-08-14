# Test fixture provenance

Binary JAR fixtures are deliberately excluded from Git. Before configuring the
native b-jvm test target, run:

```sh
TRACEJVM_JAVA23_HOME=/path/to/pinned/jdk-23 pnpm materialize:test-fixtures
```

The materializer verifies every downloaded or package-owned byte before it is
placed under `engine/bjvm/test`. Generated paths are ignored by Git.

## Package-owned platform fixture

`jdk23.jar` is copied from the package's committed, content-addressed runtime
archive. `runtime-release/manifest.json` supplies its SHA-256 trust anchor, and
`pnpm materialize:package-runtime` verifies the archive before extraction. Its
OpenJDK source and legal material are documented by `runtime/manifest.json`,
`THIRD_PARTY_NOTICES.md`, and the immutable runtime release.

## Project-built fixtures

The materializer compiles these repository sources with the pinned JDK 23 and
creates timestamp-normalized JARs without generated manifests:

| Generated path | Repository source |
| --- | --- |
| `test_files/basic_classloader/external.jar` | `test_files/basic_classloader/ExternalClass.java` |
| `test_files/intact_jar/ok.jar` | `test_files/intact_jar/Main.java` |
| `test_files/url-classloader/test.jar` | `test_files/url-classloader/DynamicallyLoaded.java` |

`test_files/broken_jar/this_is_a_jar.jar` is a deterministic malformed input
written by the materializer for ZIP error-path coverage.

## Maven Central fixtures

The remaining JARs are downloaded directly from Maven Central over HTTPS and
accepted only when their SHA-256 matches `scripts/materialize-test-fixtures.mjs`:

| Generated path | Maven coordinate |
| --- | --- |
| `test_files/json/gson-2.11.0.jar` | `com.google.code.gson:gson:2.11.0` |
| `test_files/json/jackson-annotations-2.18.2.jar` | `com.fasterxml.jackson.core:jackson-annotations:2.18.2` |
| `test_files/json/jackson-core-2.18.2.jar` | `com.fasterxml.jackson.core:jackson-core:2.18.2` |
| `test_files/json/jackson-databind-2.18.2.jar` | `com.fasterxml.jackson.core:jackson-databind:2.18.2` |
| `test_files/share/junit-platform-console-standalone-1.12.0.jar` | `org.junit.platform:junit-platform-console-standalone:1.12.0` |
| `test_files/share/kotlin-stdlib-2.1.10.jar` | `org.jetbrains.kotlin:kotlin-stdlib:2.1.10` |

These fetched artifacts are development-only test inputs. They are not part of
the Git repository, npm package, or runtime release.
