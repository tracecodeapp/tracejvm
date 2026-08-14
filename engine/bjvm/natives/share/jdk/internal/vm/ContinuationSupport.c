#include <natives-dsl.h>

// b-jvm has a cooperative host scheduler but does not implement HotSpot continuations. Report
// that capability honestly so Java 23 can select its supported scheduling path instead of
// surfacing an internal UnsatisfiedLinkError.
DECLARE_NATIVE("jdk/internal/vm", ContinuationSupport, isSupported0, "()Z") {
  return (stack_value){.i = false};
}
