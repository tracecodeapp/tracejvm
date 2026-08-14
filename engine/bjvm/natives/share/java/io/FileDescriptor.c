#include <natives-dsl.h>
#include <tracejvm-host.h>
#ifdef EMSCRIPTEN
#include <fcntl.h>
#else
#include <sys/fcntl.h>
#endif
#include <unistd.h>

DECLARE_NATIVE("java/io", FileDescriptor, initIDs, "()V") { return value_null(); }

DECLARE_NATIVE("java/io", FileDescriptor, set, "(I)J") { return (stack_value){.l = args[0].i}; }

DECLARE_NATIVE("java/io", FileDescriptor, getHandle, "(I)J") { return (stack_value){.l = args[0].i}; }

DECLARE_NATIVE("java/io", FileDescriptor, getAppend, "(I)Z") {
  if (tracejvm_host_is_remote_fd(args[0].i))
    return (stack_value){.i = 0};
  int flags = fcntl(args[0].i, F_GETFL);
  return (stack_value){.i = flags >= 0 && (flags & O_APPEND) != 0};
}

// unix-specific implementation: ignore the windows handle
DECLARE_NATIVE("java/io", FileDescriptor, close0, "()V") {
  s32 fd = LoadFieldInt(obj->obj, "fd");
  if (fd != -1)
    tracejvm_host_close(fd);
  StoreFieldInt(obj->obj, "fd", -1);
  return value_null();
}
