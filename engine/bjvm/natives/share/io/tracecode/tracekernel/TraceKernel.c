#include <errno.h>
#include <natives-dsl.h>
#include <stdio.h>
#include <string.h>
#include <tracejvm-host.h>

static void raise_tracekernel_exception(
    vm_thread *thread,
    char const *operation) {
  char message[160];
  snprintf(
      message,
      sizeof(message),
      "TraceKernel %s failed: %s",
      operation,
      strerror(errno));
  raise_vm_exception(
      thread,
      STR("java/io/IOException"),
      (slice){.chars = message, .len = strlen(message)});
}

static stack_value long_array(
    vm_thread *thread,
    int64_t const *values,
    int length) {
  obj_header *array = CreatePrimitiveArray1D(thread, TYPE_KIND_LONG, length);
  if (!array)
    return value_null();
  memcpy(ArrayData(array), values, (size_t)length * sizeof(int64_t));
  return (stack_value){.obj = array};
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, identity0, "()[J") {
  int64_t identity[4];
  if (tracejvm_host_identity_snapshot(identity) != 0) {
    raise_tracekernel_exception(thread, "identity");
    return value_null();
  }
  return long_array(thread, identity, 4);
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, watchdog0, "(IJI)[J") {
  int64_t status[4];
  if (tracejvm_host_watchdog(
          args[0].i, args[1].l, args[2].i, status) != 0) {
    raise_tracekernel_exception(thread, "watchdog");
    return value_null();
  }
  return long_array(thread, status, 4);
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, setsid0, "()[J") {
  int64_t identity[2];
  if (tracejvm_host_setsid(identity) != 0) {
    raise_tracekernel_exception(thread, "setsid");
    return value_null();
  }
  return long_array(thread, identity, 2);
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, setpgid0, "(JJ)J") {
  int64_t pgid = tracejvm_host_setpgid(args[0].l, args[1].l);
  if (pgid < 0) {
    raise_tracekernel_exception(thread, "setpgid");
    return value_null();
  }
  return (stack_value){.l = pgid};
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, tcgetpgrp0, "(I)J") {
  int64_t pgid = tracejvm_host_tcgetpgrp(args[0].i);
  if (pgid < 0) {
    raise_tracekernel_exception(thread, "tcgetpgrp");
    return value_null();
  }
  return (stack_value){.l = pgid};
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, tcsetpgrp0, "(IJ)J") {
  int64_t pgid = tracejvm_host_tcsetpgrp(args[0].i, args[1].l);
  if (pgid < 0) {
    raise_tracekernel_exception(thread, "tcsetpgrp");
    return value_null();
  }
  return (stack_value){.l = pgid};
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, tcgetwinsize0, "(I)[J") {
  int64_t size[2];
  if (tracejvm_host_tcgetwinsize(args[0].i, size) != 0) {
    raise_tracekernel_exception(thread, "tcgetwinsize");
    return value_null();
  }
  return long_array(thread, size, 2);
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, tcsetwinsize0, "(IJJ)[J") {
  int64_t size[2];
  if (tracejvm_host_tcsetwinsize(
          args[0].i, args[1].l, args[2].l, size) != 0) {
    raise_tracekernel_exception(thread, "tcsetwinsize");
    return value_null();
  }
  return long_array(thread, size, 2);
}

DECLARE_NATIVE(
    "io/tracecode/tracekernel", TraceKernel, pollSignal0, "()I") {
  int signal = tracejvm_host_poll_signal();
  if (signal < 0) {
    raise_tracekernel_exception(thread, "poll signal");
    return value_null();
  }
  return (stack_value){.i = signal};
}
