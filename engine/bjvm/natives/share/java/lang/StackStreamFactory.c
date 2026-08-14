#include <natives-dsl.h>

/*
 * OpenJDK uses this bootstrap check to assert that the VM's StackWalker mode
 * constants agree with java.lang.StackStreamFactory. This engine consumes
 * the OpenJDK constants directly and has no second, independently numbered
 * mode table, so the values cannot diverge.
 */
DECLARE_NATIVE("java/lang", StackStreamFactory, checkStackWalkModes, "()Z") {
  return (stack_value){.i = 1};
}
