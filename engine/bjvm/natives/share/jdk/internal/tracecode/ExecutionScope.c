#include <natives-dsl.h>

DECLARE_NATIVE("jdk/internal/tracecode", ExecutionScope, threadCreationEpoch, "()J") {
  return (stack_value){.l = (s64)thread->vm->thread_creation_epoch};
}
