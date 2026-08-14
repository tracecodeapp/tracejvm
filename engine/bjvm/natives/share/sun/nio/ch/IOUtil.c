#include <limits.h>
#include <natives-dsl.h>
#include <stdio.h>
#include <tracejvm-host.h>

DECLARE_NATIVE("sun/nio/ch", IOUtil, initIDs, "()V") { return value_null(); }

DECLARE_NATIVE("sun/nio/ch", IOUtil, iovMax, "()I") { return (stack_value){.i = 1024}; }

DECLARE_NATIVE("sun/nio/ch", IOUtil, writevMax, "()J") { return (stack_value){.l = 1024}; }

DECLARE_NATIVE("sun/nio/ch", IOUtil, configureBlocking,
               "(Ljava/io/FileDescriptor;Z)V") {
  if (!args[0].handle || !args[0].handle->obj) {
    raise_vm_exception(thread, STR("java/io/IOException"),
                       STR("Invalid file descriptor"));
    return value_null();
  }
  int fd = LoadFieldInt(args[0].handle->obj, "fd");
  if (tracejvm_host_configure_blocking(fd, args[1].i != 0) != 0) {
    INIT_STACK_STRING(message, 128);
    bprintf(message, "configureBlocking(fd=%d): %s", fd, strerror(errno));
    raise_vm_exception(thread, STR("java/io/IOException"), message);
  }
  return value_null();
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, fdVal,
               "(Ljava/io/FileDescriptor;)I") {
  return (stack_value){.i =
      args[0].handle && args[0].handle->obj
          ? LoadFieldInt(args[0].handle->obj, "fd")
          : -1};
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, setfdVal,
               "(Ljava/io/FileDescriptor;I)V") {
  if (args[0].handle && args[0].handle->obj)
    StoreFieldInt(args[0].handle->obj, "fd", args[1].i);
  return value_null();
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, fdLimit, "()I") {
  return (stack_value){.i = 1 << 20};
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, makePipe, "(Z)J") {
  int descriptors[2];
  if (tracejvm_host_pipe(descriptors, args[0].i != 0) != 0) {
    INIT_STACK_STRING(message, 128);
    bprintf(message, "makePipe: %s", strerror(errno));
    raise_vm_exception(thread, STR("java/io/IOException"), message);
    return value_null();
  }
  return (stack_value){.l =
      ((int64_t)(uint32_t)descriptors[0] << 32) |
      (uint32_t)descriptors[1]};
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, write1, "(IB)I") {
  uint8_t byte = (uint8_t)args[1].i;
  ssize_t result =
      tracejvm_host_write(args[0].i, &byte, sizeof(byte), 0, false);
  if (result < 0) {
    INIT_STACK_STRING(message, 128);
    bprintf(message, "write1(fd=%d): %s", args[0].i, strerror(errno));
    raise_vm_exception(thread, STR("java/io/IOException"), message);
    return value_null();
  }
  return (stack_value){.i = (int)result};
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, drain, "(I)Z") {
  uint8_t buffer[64];
  bool drained = false;
  while (true) {
    ssize_t result =
        tracejvm_host_read(args[0].i, buffer, sizeof(buffer), 0, false);
    if (result > 0) {
      drained = true;
      continue;
    }
    if (result == 0 || errno == EAGAIN)
      break;
    INIT_STACK_STRING(message, 128);
    bprintf(message, "drain(fd=%d): %s", args[0].i, strerror(errno));
    raise_vm_exception(thread, STR("java/io/IOException"), message);
    return value_null();
  }
  return (stack_value){.i = drained};
}

DECLARE_NATIVE("sun/nio/ch", IOUtil, drain1, "(I)I") {
  uint8_t byte;
  ssize_t result =
      tracejvm_host_read(args[0].i, &byte, sizeof(byte), 0, false);
  if (result >= 0)
    return (stack_value){.i = (int)result};
  if (errno == EAGAIN)
    return (stack_value){.i = 0};
  INIT_STACK_STRING(message, 128);
  bprintf(message, "drain1(fd=%d): %s", args[0].i, strerror(errno));
  raise_vm_exception(thread, STR("java/io/IOException"), message);
  return value_null();
}
