#include <natives-dsl.h>

DECLARE_NATIVE("java/io", ObjectStreamClass, initNative, "()V") { return value_null(); }

DECLARE_NATIVE("java/io", ObjectStreamClass, hasStaticInitializer, "(Ljava/lang/Class;)Z") {
  DCHECK(argc == 1);
  if (args[0].handle->obj == nullptr) {
    raise_null_pointer_exception(thread);
    return value_null();
  }

  classdesc *desc = unmirror_class(args[0].handle->obj);
  for (int i = 0; i < desc->methods_count; ++i) {
    if (desc->methods[i].is_clinit) {
      return (stack_value){.i = 1};
    }
  }
  return (stack_value){.i = 0};
}
