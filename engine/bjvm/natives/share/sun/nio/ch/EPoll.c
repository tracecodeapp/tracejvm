#include <errno.h>
#include <natives-dsl.h>
#include <roundrobin_scheduler.h>
#include <stdint.h>
#include <string.h>
#include <tracejvm-host.h>

enum {
  TRACEJVM_EPOLL_EVENT_SIZE = 12,
  TRACEJVM_EPOLL_EVENTS_OFFSET = 0,
  TRACEJVM_EPOLL_DATA_OFFSET = 4,
};

static void raise_epoll_exception(
    vm_thread *thread, char const *operation, int error) {
  INIT_STACK_STRING(message, 160);
  bprintf(message, "%s: %s", operation, strerror(error));
  raise_vm_exception(thread, STR("java/io/IOException"), message);
}

DECLARE_NATIVE("sun/nio/ch", EPoll, eventSize, "()I") {
  return (stack_value){.i = TRACEJVM_EPOLL_EVENT_SIZE};
}

DECLARE_NATIVE("sun/nio/ch", EPoll, eventsOffset, "()I") {
  return (stack_value){.i = TRACEJVM_EPOLL_EVENTS_OFFSET};
}

DECLARE_NATIVE("sun/nio/ch", EPoll, dataOffset, "()I") {
  return (stack_value){.i = TRACEJVM_EPOLL_DATA_OFFSET};
}

DECLARE_NATIVE("sun/nio/ch", EPoll, create, "()I") {
  int fd = tracejvm_host_epoll_create();
  if (fd < 0) {
    raise_epoll_exception(thread, "epoll_create", errno);
    return value_null();
  }
  return (stack_value){.i = fd};
}

DECLARE_NATIVE("sun/nio/ch", EPoll, ctl, "(IIII)I") {
  int result =
      tracejvm_host_epoll_ctl(args[0].i, args[1].i, args[2].i, args[3].i);
  return (stack_value){.i = result == 0 ? 0 : errno};
}

DECLARE_ASYNC_NATIVE(
    "sun/nio/ch", EPoll, wait, "(IJII)I",
    locals(
      int call_id;
      int result;
      rr_wakeup_info wakeup_info;
    ),
    invoked_methods()) {
  DEBUG_PEDANTIC_YIELD(self->wakeup_info);

  int capacity = args[2].i;
  if (capacity < 0 || capacity > 1024 || args[1].l == 0) {
    raise_epoll_exception(thread, "epoll_wait", EINVAL);
    ASYNC_RETURN(value_null());
  }
  if (self->call_id == 0) {
    self->call_id =
        tracejvm_host_epoll_wait_begin(args[0].i, args[3].i);
    if (self->call_id < 0) {
      raise_epoll_exception(thread, "epoll_wait", errno);
      ASYNC_RETURN(value_null());
    }
  }
  while (true) {
    self->result = tracejvm_host_epoll_wait_poll(
        self->call_id, (void *)(uintptr_t)args[1].l, capacity);
    if (self->result != TRACEJVM_HOST_ASYNC_PENDING)
      break;
    self->wakeup_info.kind = RR_WAKEUP_SLEEP;
    self->wakeup_info.wakeup_us = get_unix_us() + 1000;
    ASYNC_YIELD((void *)&self->wakeup_info);
    DEBUG_PEDANTIC_YIELD(self->wakeup_info);
  }
  if (self->result < 0) {
    raise_epoll_exception(thread, "epoll_wait", errno);
    ASYNC_RETURN(value_null());
  }
  ASYNC_END((stack_value){.i = self->result});
}

DECLARE_NATIVE("sun/nio/ch", EventFD, eventfd0, "()I") {
  int fd = tracejvm_host_eventfd();
  if (fd < 0) {
    raise_epoll_exception(thread, "eventfd", errno);
    return value_null();
  }
  return (stack_value){.i = fd};
}

DECLARE_NATIVE("sun/nio/ch", EventFD, set0, "(I)I") {
  int result = tracejvm_host_eventfd_set(args[0].i);
  if (result != 0) {
    raise_epoll_exception(thread, "eventfd_write", errno);
    return value_null();
  }
  return (stack_value){.i = 1};
}
