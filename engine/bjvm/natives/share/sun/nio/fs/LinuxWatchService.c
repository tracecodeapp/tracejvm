#include <errno.h>
#include <natives-dsl.h>
#include <roundrobin_scheduler.h>
#include <stdint.h>
#include <string.h>
#include <tracejvm-host.h>

enum {
  TRACEJVM_INOTIFY_EVENT_SIZE = 16,
  TRACEJVM_INOTIFY_WD_OFFSET = 0,
  TRACEJVM_INOTIFY_MASK_OFFSET = 4,
  TRACEJVM_INOTIFY_COOKIE_OFFSET = 8,
  TRACEJVM_INOTIFY_LEN_OFFSET = 12,
  TRACEJVM_INOTIFY_NAME_OFFSET = 16,
};

static int openjdk_linux_errno(int host_errno) {
#ifdef EMSCRIPTEN
  switch (host_errno) {
    case EACCES: return 13;
    case EAGAIN: return 11;
    case EBADF: return 9;
    case EEXIST: return 17;
    case EINVAL: return 22;
    case EMFILE: return 24;
    case ENAMETOOLONG: return 36;
    case ENOENT: return 2;
    case ENOSPC: return 28;
    case ENOSYS: return 38;
    case ENOTDIR: return 20;
    default: return host_errno;
  }
#else
  return host_errno;
#endif
}

static void raise_unix_exception(vm_thread *thread, int error) {
  classdesc *descriptor = cached_classes(thread->vm)->unix_exception;
  obj_header *exception = new_object(thread, descriptor);
  cp_method *constructor = method_lookup(
      descriptor, STR("<init>"), STR("(I)V"), true, false);
  call_interpreter_synchronous(
      thread,
      constructor,
      (stack_value[]){
          {.obj = exception},
          {.i = openjdk_linux_errno(error)},
      });
  thread->current_exception = exception;
}

DECLARE_NATIVE("sun/nio/fs", LinuxWatchService, eventSize, "()I") {
  return (stack_value){.i = TRACEJVM_INOTIFY_EVENT_SIZE};
}

DECLARE_NATIVE("sun/nio/fs", LinuxWatchService, eventOffsets, "()[I") {
  obj_header *offsets = CreatePrimitiveArray1D(thread, TYPE_KIND_INT, 5);
  if (!offsets)
    return value_null();
  int32_t *values = ArrayData(offsets);
  values[0] = TRACEJVM_INOTIFY_WD_OFFSET;
  values[1] = TRACEJVM_INOTIFY_MASK_OFFSET;
  values[2] = TRACEJVM_INOTIFY_COOKIE_OFFSET;
  values[3] = TRACEJVM_INOTIFY_LEN_OFFSET;
  values[4] = TRACEJVM_INOTIFY_NAME_OFFSET;
  return (stack_value){.obj = offsets};
}

DECLARE_NATIVE("sun/nio/fs", LinuxWatchService, inotifyInit, "()I") {
  int fd = tracejvm_host_inotify_init();
  if (fd < 0) {
    raise_unix_exception(thread, errno);
    return value_null();
  }
  return (stack_value){.i = fd};
}

DECLARE_NATIVE(
    "sun/nio/fs", LinuxWatchService, inotifyAddWatch, "(IJI)I") {
  char const *path = (char const *)(uintptr_t)args[1].l;
  int wd =
      tracejvm_host_inotify_add_watch(args[0].i, path, args[2].i);
  if (wd < 0) {
    raise_unix_exception(thread, errno);
    return value_null();
  }
  return (stack_value){.i = wd};
}

DECLARE_NATIVE(
    "sun/nio/fs", LinuxWatchService, inotifyRmWatch, "(II)V") {
  if (tracejvm_host_inotify_rm_watch(args[0].i, args[1].i) != 0)
    raise_unix_exception(thread, errno);
  return value_null();
}

DECLARE_NATIVE(
    "sun/nio/fs", LinuxWatchService, configureBlocking, "(IZ)V") {
  if (tracejvm_host_configure_blocking(args[0].i, args[1].i != 0) != 0)
    raise_unix_exception(thread, errno);
  return value_null();
}

DECLARE_NATIVE(
    "sun/nio/fs", LinuxWatchService, socketpair, "([I)V") {
  if (!args[0].handle || !args[0].handle->obj ||
      ArrayLength(args[0].handle->obj) < 2) {
    raise_unix_exception(thread, EINVAL);
    return value_null();
  }
  int descriptors[2];
  if (tracejvm_host_pipe(descriptors, true) != 0) {
    raise_unix_exception(thread, errno);
    return value_null();
  }
  int32_t *target = ArrayData(args[0].handle->obj);
  target[0] = descriptors[0];
  target[1] = descriptors[1];
  return value_null();
}

DECLARE_ASYNC_NATIVE(
    "sun/nio/fs", LinuxWatchService, poll, "(II)I",
    locals(
      int call_id;
      int result;
      rr_wakeup_info wakeup_info;
    ),
    invoked_methods()) {
  DEBUG_PEDANTIC_YIELD(self->wakeup_info);

  if (self->call_id == 0) {
    self->call_id =
        tracejvm_host_inotify_poll_begin(args[0].i, args[1].i);
    if (self->call_id < 0) {
      raise_unix_exception(thread, errno);
      ASYNC_RETURN(value_null());
    }
  }
  while (true) {
    self->result = tracejvm_host_inotify_poll_poll(self->call_id);
    if (self->result != TRACEJVM_HOST_ASYNC_PENDING)
      break;
    self->wakeup_info.kind = RR_WAKEUP_SLEEP;
    self->wakeup_info.wakeup_us = get_unix_us() + 1000;
    ASYNC_YIELD((void *)&self->wakeup_info);
    DEBUG_PEDANTIC_YIELD(self->wakeup_info);
  }
  if (self->result < 0) {
    raise_unix_exception(thread, errno);
    ASYNC_RETURN(value_null());
  }
  ASYNC_END((stack_value){.i = self->result});
}
