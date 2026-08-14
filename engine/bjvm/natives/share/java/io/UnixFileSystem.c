#include "unixlike-fs.h"

#include <natives-dsl.h>
#include <tracejvm-host.h>
#ifdef EMSCRIPTEN
#include <fcntl.h>
#else
#include <sys/fcntl.h>
#endif
#include <sys/stat.h>
#include <unistd.h>

#include "unixlike-fs.h"

DECLARE_NATIVE("java/io", UnixFileSystem, initIDs, "()V") { return value_null(); }

DECLARE_NATIVE("java/io", UnixFileSystem, checkAccess0, "(Ljava/io/File;I)Z") { return (stack_value){.i = 1}; }

DECLARE_NATIVE("java/io", UnixFileSystem, getNameMax0, "(Ljava/lang/String;)J") {
  if (!args[0].handle->obj) {
    raise_null_pointer_exception(thread);
    return value_null();
  }
  heap_string path = AsHeapString(args[0].handle->obj, on_oom);
  long name_max = pathconf(path.chars, _PC_NAME_MAX);
  free_heap_str(path);
  return (stack_value){.l = name_max > 0 ? name_max : 255};

on_oom:
  return (stack_value){.l = 255};
}

DECLARE_NATIVE("java/io", UnixFileSystem, createFileExclusively0, "(Ljava/lang/String;)Z") {
  if (!args[0].handle->obj) {
    raise_null_pointer_exception(thread);
    return value_null();
  }
  heap_string path = AsHeapString(args[0].handle->obj, on_oom);
  int fd = tracejvm_host_open(
      path.chars, O_WRONLY | O_CREAT | O_EXCL, 0666);
  if (fd >= 0) tracejvm_host_close(fd);
  free_heap_str(path);
  return (stack_value){.i = fd >= 0};

on_oom:
  return (stack_value){.i = 0};
}
DECLARE_ASYNC_NATIVE("java/io", UnixFileSystem, getBooleanAttributes0, "(Ljava/io/File;)I", locals(),
                     invoked_methods()) {
  obj_header *file_obj = args[0].handle->obj;
  obj_header *path = LoadFieldObject(file_obj, "java/lang/String", "path");

  heap_string path_str = AsHeapString(path, on_oom);

  struct stat st;
  int result = tracejvm_host_stat(path_str.chars, &st, true) != 0
      ? 0
      : BA_EXISTS | (S_ISDIR(st.st_mode) ? BA_DIRECTORY : BA_REGULAR);
  free_heap_str(path_str);

  ASYNC_RETURN((stack_value){.i = result});

on_oom:
  ASYNC_END(value_null());
}

static heap_string canonicalize_path(slice path) {
  slice *components = nullptr;

  u32 i = 0;
  for (u32 j = 0; j <= path.len; ++j) {
    if (path.chars[j] == '/' || j == path.len) {
      slice slc = (slice){path.chars + i, j - i};
      if (utf8_equals(slc, "..")) {
        if (arrlen(components)) {
          arrpop(components);
        }
      } else if (!utf8_equals(slc, ".") && i < j) {
        arrput(components, slc);
      }
      i = j + 1;
    }
  }

  i = 0;
  heap_string result = make_heap_str(path.len);
  for (u32 component_i = 0; component_i < arrlen(components); ++component_i) {
    result.chars[i++] = '/';
    for (u32 j = 0; j < components[component_i].len; ++j) {
      result.chars[i++] = components[component_i].chars[j];
    }
  }
  result.len = i;
  arrfree(components);
  return result;
}

DECLARE_NATIVE("java/io", UnixFileSystem, canonicalize0, "(Ljava/lang/String;)Ljava/lang/String;") {
  if (!args[0].handle->obj) {
    raise_null_pointer_exception(thread);
    return value_null();
  }

  // Concatenate the current working directory with the given path
  object raw = RawStringData(thread, args[0].handle->obj);
  slice data = (slice){.chars = ArrayData(raw), .len = ArrayLength(raw)};

  heap_string canonical = canonicalize_path(data); // todo: deal with oom here

  // canonicalize_path only is looking for sequences of .. and /, whcih look the same regardless of the coding.
  // It passes other elements on as-is, meaning the canonicalized string has the same encoding as the input string
  string_coder_kind coder = ((struct native_String *)args[0].handle->obj)->coder;
  obj_header *result = MakeJStringFromData(thread, hslc(canonical), coder);

  free_heap_str(canonical);

  return (stack_value){.obj = result};
}

DECLARE_NATIVE("java/io", UnixFileSystem, getLastModifiedTime0, "(Ljava/io/File;)J") {
  obj_header *file_obj = args[0].handle->obj;
  obj_header *path = LoadFieldObject(file_obj, "java/lang/String", "path");

  heap_string path_str = AsHeapString(path, on_oom);

  struct stat st;
  stack_value result = tracejvm_host_stat(path_str.chars, &st, true) != 0
      ? value_null()
      : (stack_value){
            .l = (s64)st.st_mtim.tv_sec * 1000 +
                 st.st_mtim.tv_nsec / 1000000};
  free_heap_str(path_str);
  return result;

on_oom:
  return value_null();
}

DECLARE_NATIVE("java/io", UnixFileSystem, getLength0, "(Ljava/io/File;)J") {
  obj_header *file_obj = args[0].handle->obj;
  obj_header *path = LoadFieldObject(file_obj, "java/lang/String", "path");

  heap_string path_str = AsHeapString(path, on_oom);
  struct stat st;
  stack_value result =
      tracejvm_host_stat(path_str.chars, &st, true) == 0
          ? (stack_value){.l = st.st_size}
          : (stack_value){.l = 0};
  free_heap_str(path_str);
  return result;

on_oom:
  return value_null();
}

DECLARE_NATIVE("java/io", UnixFileSystem, delete0, "(Ljava/io/File;)Z") {
  obj_header *file_obj = args[0].handle->obj;
  obj_header *path = LoadFieldObject(file_obj, "java/lang/String", "path");
  heap_string path_str = AsHeapString(path, on_oom);
  struct stat st;
  int result = 0;
  if (tracejvm_host_stat(path_str.chars, &st, true) == 0) {
    result = S_ISDIR(st.st_mode)
      ? tracejvm_host_rmdir(path_str.chars) == 0
      : tracejvm_host_unlink(path_str.chars) == 0;
  }
  free_heap_str(path_str);
  return (stack_value){.i = result};

on_oom:
  return (stack_value){.i = 0};
}

DECLARE_NATIVE("java/io", UnixFileSystem, createDirectory0, "(Ljava/io/File;)Z") {
  obj_header *file_obj = args[0].handle->obj;
  if (!file_obj) {
    raise_null_pointer_exception(thread);
    return value_null();
  }

  obj_header *path = LoadFieldObject(file_obj, "java/lang/String", "path");
  heap_string path_str = AsHeapString(path, on_oom);
  int result = tracejvm_host_mkdir(path_str.chars, 0777) == 0;
  free_heap_str(path_str);
  return (stack_value){.i = result};

on_oom:
  return (stack_value){.i = 0};
}
