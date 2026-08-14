#include <arrays.h>
#include <errno.h>
#include <natives-dsl.h>
#include <roundrobin_scheduler.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <tracejvm-host.h>

DECLARE_NATIVE("java/lang", ProcessEnvironment, environ, "()[[B") {
  enum {
    ENVIRONMENT_BLOCK_LIMIT = 8 * 1024 * 1024,
    ENVIRONMENT_ENTRY_LIMIT = 65536,
  };
  classdesc *byte_array = bootstrap_lookup_class(thread, STR("[B"));
  size_t block_length = 0;
  int entry_count = 0;
  int status = tracejvm_host_environment(
      nullptr,
      0,
      &block_length,
      &entry_count);
  if (
    status < 0 ||
    block_length > ENVIRONMENT_BLOCK_LIMIT ||
    entry_count < 0 ||
    entry_count > ENVIRONMENT_ENTRY_LIMIT
  ) {
    obj_header *empty = CreateObjectArray1D(thread, byte_array, 0);
    return (stack_value){.obj = empty};
  }

  int expected_entry_count = entry_count;
  int value_count = entry_count * 2;
  size_t block_capacity = block_length;
  handle *entries = make_handle(
      thread,
      CreateObjectArray1D(thread, byte_array, value_count));
  if (!entries->obj || entry_count == 0) {
    obj_header *result = entries->obj;
    drop_handle(thread, entries);
    return (stack_value){.obj = result};
  }

  char *block = malloc(block_length);
  if (!block) {
    drop_handle(thread, entries);
    return value_null();
  }
  status = tracejvm_host_environment(
      block,
      block_capacity,
      &block_length,
      &entry_count);
  if (
    status != 0 ||
    entry_count != expected_entry_count ||
    block_length > block_capacity
  ) {
    free(block);
    drop_handle(thread, entries);
    return value_null();
  }

  char *cursor = block;
  size_t remaining = block_length;
  for (int index = 0; index < value_count; index += 1) {
    char *end = memchr(cursor, '\0', remaining);
    if (!end) {
      free(block);
      drop_handle(thread, entries);
      return value_null();
    }
    size_t length = (size_t)(end - cursor);
    obj_header *entry =
        CreatePrimitiveArray1D(thread, TYPE_KIND_BYTE, (s32)length);
    if (!entry) {
      free(block);
      drop_handle(thread, entries);
      return value_null();
    }
    memcpy(ArrayData(entry), cursor, length);
    ReferenceArrayStore(entries->obj, index, entry);
    size_t consumed = length + 1;
    cursor += consumed;
    remaining -= consumed;
  }
  if (remaining != 0) {
    free(block);
    drop_handle(thread, entries);
    return value_null();
  }

  obj_header *result = entries->obj;
  free(block);
  drop_handle(thread, entries);
  return (stack_value){.obj = result};
}

DECLARE_NATIVE("java/lang", ProcessImpl, init, "()V") { return value_null(); }

// private native int forkAndExec(int mode, byte[] helperpath,
// byte[] prog,
// byte[] argBlock, int argc,
// byte[] envBlock, int envc,
// byte[] dir,
// int[] fds,
// boolean redirectErrorStream)
DECLARE_NATIVE("java/lang", ProcessImpl, forkAndExec, "(I[B[B[BI[BI[B[IZ)I") {
  obj_header *program = args[2].handle->obj;
  obj_header *argument_block = args[3].handle->obj;
  obj_header *environment_block =
      args[5].handle ? args[5].handle->obj : nullptr;
  obj_header *directory = args[7].handle ? args[7].handle->obj : nullptr;
  obj_header *descriptor_array = args[8].handle->obj;
  if (
    !program || !argument_block || !descriptor_array ||
    ArrayLength(descriptor_array) < 3
  ) {
    raise_vm_exception(
        thread, STR("java/io/IOException"),
        STR("Invalid process launch arguments"));
    return value_null();
  }
  int pid = tracejvm_host_spawn(
      (char const *)ArrayData(program),
      (char const *)ArrayData(argument_block),
      (size_t)ArrayLength(argument_block),
      args[4].i,
      environment_block ? (char const *)ArrayData(environment_block) : nullptr,
      environment_block ? (size_t)ArrayLength(environment_block) : 0,
      args[6].i,
      directory ? (char const *)ArrayData(directory) : nullptr,
      (int *)ArrayData(descriptor_array),
      args[9].i != 0);
  if (pid < 0) {
    char message[192];
    snprintf(
        message, sizeof(message), "Host process launch failed: %s",
        strerror(errno));
    raise_vm_exception(
        thread, STR("java/io/IOException"),
        (slice){.chars = message, .len = strlen(message)});
    return value_null();
  }
  return (stack_value){.i = pid};
}

DECLARE_NATIVE("java/lang", ProcessHandleImpl, initNative, "()V") { return value_null(); }

DECLARE_NATIVE("java/lang", ProcessHandleImpl, getCurrentPid0, "()J") {
  return (stack_value){.l = tracejvm_host_current_pid()};
}

DECLARE_NATIVE("java/lang", ProcessHandleImpl, parent0, "(JJ)J") {
  int64_t parent = tracejvm_host_parent_pid(args[0].l);
  return (stack_value){.l = parent > 0 ? parent : -1};
}

DECLARE_NATIVE("java/lang", ProcessHandleImpl, isAlive0, "(J)J") {
  return (stack_value){.l = tracejvm_host_process_start_time(args[0].l)};
}

DECLARE_NATIVE(
    "java/lang", ProcessHandleImpl, getProcessPids0, "(J[J[J[J)I") {
  obj_header *pids = args[1].handle ? args[1].handle->obj : nullptr;
  obj_header *parent_pids = args[2].handle ? args[2].handle->obj : nullptr;
  obj_header *start_times = args[3].handle ? args[3].handle->obj : nullptr;
  if (!pids)
    return (stack_value){.i = 0};

  int capacity = ArrayLength(pids);
  if (
    (parent_pids && ArrayLength(parent_pids) < capacity) ||
    (start_times && ArrayLength(start_times) < capacity)
  ) {
    return (stack_value){.i = 0};
  }

  int count = tracejvm_host_process_list(
      args[0].l,
      (int64_t *)ArrayData(pids),
      parent_pids ? (int64_t *)ArrayData(parent_pids) : nullptr,
      start_times ? (int64_t *)ArrayData(start_times) : nullptr,
      capacity);
  return (stack_value){.i = count >= 0 ? count : 0};
}

DECLARE_NATIVE("java/lang", ProcessHandleImpl, destroy0, "(JJZ)Z") {
  return (stack_value){
      .i = tracejvm_host_kill(args[0].l, args[2].i != 0) == 0};
}

DECLARE_NATIVE("java/lang", ProcessHandleImpl_Info, initIDs, "()V") {
  return value_null();
}

DECLARE_NATIVE("java/lang", ProcessHandleImpl_Info, info0, "(J)V") {
  enum {
    PROCESS_METADATA_LIMIT = 8 * 1024 * 1024,
    PROCESS_ARGUMENT_LIMIT = 65536,
  };
  size_t command_length = 0;
  size_t argument_block_length = 0;
  int argument_count = 0;
  int64_t start_time = -1;
  int status = tracejvm_host_process_info(
      args[0].l,
      nullptr,
      0,
      nullptr,
      0,
      &command_length,
      &argument_block_length,
      &argument_count,
      &start_time);
  if (
    status < 0 ||
    command_length >= PROCESS_METADATA_LIMIT ||
    argument_block_length > PROCESS_METADATA_LIMIT ||
    command_length + argument_block_length > PROCESS_METADATA_LIMIT ||
    argument_count < 0 ||
    argument_count > PROCESS_ARGUMENT_LIMIT
  ) {
    return value_null();
  }

  char *command = malloc(command_length + 1);
  char *argument_block =
      argument_block_length > 0 ? malloc(argument_block_length) : nullptr;
  if (!command || (argument_block_length > 0 && !argument_block)) {
    free(command);
    free(argument_block);
    return value_null();
  }

  status = tracejvm_host_process_info(
      args[0].l,
      command,
      command_length + 1,
      argument_block,
      argument_block_length,
      &command_length,
      &argument_block_length,
      &argument_count,
      &start_time);
  if (status != 0) {
    free(command);
    free(argument_block);
    return value_null();
  }

  handle *command_string = make_handle(
      thread,
      MakeJStringFromModifiedUTF8(
          thread,
          (slice){.chars = command, .len = command_length},
          false));
  handle *arguments = make_handle(
      thread,
      CreateObjectArray1D(
          thread,
          cached_classes(thread->vm)->string,
          argument_count));
  if (!command_string->obj || !arguments->obj) {
    drop_handle(thread, arguments);
    drop_handle(thread, command_string);
    free(command);
    free(argument_block);
    return value_null();
  }

  char *cursor = argument_block;
  size_t remaining = argument_block_length;
  for (int index = 0; index < argument_count; index += 1) {
    char *end = memchr(cursor, '\0', remaining);
    if (!end) {
      drop_handle(thread, arguments);
      drop_handle(thread, command_string);
      free(command);
      free(argument_block);
      return value_null();
    }
    obj_header *argument = MakeJStringFromModifiedUTF8(
        thread,
        (slice){.chars = cursor, .len = (size_t)(end - cursor)},
        false);
    if (!argument) {
      drop_handle(thread, arguments);
      drop_handle(thread, command_string);
      free(command);
      free(argument_block);
      return value_null();
    }
    ReferenceArrayStore(arguments->obj, index, argument);
    size_t consumed = (size_t)(end - cursor) + 1;
    cursor += consumed;
    remaining -= consumed;
  }
  if (remaining != 0) {
    drop_handle(thread, arguments);
    drop_handle(thread, command_string);
    free(command);
    free(argument_block);
    return value_null();
  }

  StoreFieldObject(
      obj->obj,
      "java/lang/String",
      "command",
      command_string->obj);
  __StoreFieldObject(
      obj->obj,
      STR("[Ljava/lang/String;"),
      STR("arguments"),
      arguments->obj);
  StoreFieldLong(obj->obj, "startTime", start_time);

  drop_handle(thread, arguments);
  drop_handle(thread, command_string);
  free(command);
  free(argument_block);
  return value_null();
}

DECLARE_ASYNC_NATIVE(
    "java/lang", ProcessHandleImpl, waitForProcessExit0, "(JZ)I",
    locals(
      int call_id;
      int exit_code;
      rr_wakeup_info wakeup_info;
    ),
    invoked_methods()) {
  DEBUG_PEDANTIC_YIELD(self->wakeup_info);

  if (!args[1].i)
    ASYNC_RETURN((stack_value){.i = -2});

  if (self->call_id == 0) {
    self->call_id = tracejvm_host_wait_begin(args[0].l);
    if (self->call_id < 0)
      ASYNC_RETURN((stack_value){.i = -2});
  }

  while (true) {
    int status =
        tracejvm_host_wait_poll(self->call_id, &self->exit_code);
    if (status < 0)
      ASYNC_RETURN((stack_value){.i = -2});
    if (status > 0)
      ASYNC_RETURN((stack_value){.i = self->exit_code});

    self->wakeup_info.kind = RR_WAKEUP_SLEEP;
    self->wakeup_info.wakeup_us = get_unix_us() + 1000;
    ASYNC_YIELD((void *)&self->wakeup_info);
    DEBUG_PEDANTIC_YIELD(self->wakeup_info);
  }
  ASYNC_END((stack_value){.i = -2});
}
