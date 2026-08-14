#include <profiler.h>

#include <arrays.h>
#include <stdatomic.h>

typedef struct profiler_s {
  vm_thread *thread;
  u32 epoch;
  cp_method **methods;
  u64 opcode_counts[MAX_INSN_KIND];
  bool finished;
} profiler;

static _Atomic u32 next_epoch = 1;

enum method_feature {
  PROFILE_FEATURE_ALLOCATION = 1u << 0,
  PROFILE_FEATURE_DYNAMIC_CALL = 1u << 1,
  PROFILE_FEATURE_CALL = 1u << 2,
  PROFILE_FEATURE_FIELD = 1u << 3,
  PROFILE_FEATURE_ARRAY = 1u << 4,
  PROFILE_FEATURE_THROW = 1u << 5,
  PROFILE_FEATURE_MONITOR = 1u << 6,
  PROFILE_FEATURE_SWITCH = 1u << 7,
  PROFILE_FEATURE_TYPE_CHECK = 1u << 8,
  PROFILE_FEATURE_FLOATING_POINT = 1u << 9,
  PROFILE_FEATURE_WIDE_VALUE = 1u << 10,
  PROFILE_FEATURE_DIVISION = 1u << 11,
  PROFILE_FEATURE_SYNCHRONIZED = 1u << 12,
  PROFILE_FEATURE_EXCEPTION_TABLE = 1u << 13,
};

typedef struct method_shape_s {
  u32 features;
  u32 branches;
  u32 call_sites;
} method_shape;

static bool is_branch(insn_code_kind kind) {
  return kind == insn_goto || kind == insn_jsr ||
         (kind >= insn_if_acmpeq && kind <= insn_ifnull);
}

static bool is_floating_point(insn_code_kind kind) {
  switch (kind) {
  case insn_f2d:
  case insn_f2i:
  case insn_f2l:
  case insn_fadd:
  case insn_faload:
  case insn_fastore:
  case insn_fcmpg:
  case insn_fcmpl:
  case insn_fconst:
  case insn_fdiv:
  case insn_fload:
  case insn_fmul:
  case insn_fneg:
  case insn_frem:
  case insn_freturn:
  case insn_fstore:
  case insn_fsub:
  case insn_d2f:
  case insn_d2i:
  case insn_d2l:
  case insn_dadd:
  case insn_daload:
  case insn_dastore:
  case insn_dcmpg:
  case insn_dcmpl:
  case insn_dconst:
  case insn_ddiv:
  case insn_dload:
  case insn_dmul:
  case insn_dneg:
  case insn_drem:
  case insn_dreturn:
  case insn_dstore:
  case insn_dsub:
    return true;
  default:
    return false;
  }
}

static bool is_wide_value(insn_code_kind kind) {
  switch (kind) {
  case insn_l2d:
  case insn_l2f:
  case insn_l2i:
  case insn_ladd:
  case insn_laload:
  case insn_land:
  case insn_lastore:
  case insn_lcmp:
  case insn_lconst:
  case insn_ldiv:
  case insn_lload:
  case insn_lmul:
  case insn_lneg:
  case insn_lor:
  case insn_lrem:
  case insn_lreturn:
  case insn_lshl:
  case insn_lshr:
  case insn_lstore:
  case insn_lsub:
  case insn_lushr:
  case insn_lxor:
    return true;
  default:
    return false;
  }
}

static bool is_division(insn_code_kind kind) {
  return kind == insn_idiv || kind == insn_irem || kind == insn_ldiv ||
         kind == insn_lrem || kind == insn_fdiv || kind == insn_frem ||
         kind == insn_ddiv || kind == insn_drem;
}

static method_shape inspect_method_shape(const cp_method *method) {
  method_shape shape = {};
  const attribute_code *code = method->code;
  if (!code) {
    return shape;
  }

  if (method->access_flags & ACCESS_SYNCHRONIZED) {
    shape.features |= PROFILE_FEATURE_SYNCHRONIZED;
  }
  if (code->exception_table && code->exception_table->entries_count) {
    shape.features |= PROFILE_FEATURE_EXCEPTION_TABLE;
  }

  for (int i = 0; i < code->insn_count; ++i) {
    insn_code_kind kind = code->code[i].kind;
    shape.branches += is_branch(kind);
    switch (kind) {
    case insn_new:
    case insn_new_resolved:
    case insn_newarray:
    case insn_anewarray:
    case insn_anewarray_resolved:
    case insn_multianewarray:
      shape.features |= PROFILE_FEATURE_ALLOCATION;
      break;
    case insn_invokevirtual:
    case insn_invokeinterface:
    case insn_invokedynamic:
    case insn_invokevtable_polymorphic:
    case insn_invokeitable_polymorphic:
    case insn_invokecallsite:
    case insn_invokesigpoly:
      shape.features |= PROFILE_FEATURE_DYNAMIC_CALL;
      // Fall through: dynamic calls are also calls.
    case insn_invokevtable_monomorphic:
    case insn_invokeitable_monomorphic:
    case insn_invokespecial:
    case insn_invokestatic:
    case insn_invokespecial_resolved:
    case insn_invokestatic_resolved:
      shape.features |= PROFILE_FEATURE_CALL;
      shape.call_sites++;
      break;
    case insn_getfield:
    case insn_getstatic:
    case insn_putfield:
    case insn_putstatic:
    case insn_getfield_B:
    case insn_getfield_C:
    case insn_getfield_S:
    case insn_getfield_I:
    case insn_getfield_J:
    case insn_getfield_F:
    case insn_getfield_D:
    case insn_getfield_Z:
    case insn_getfield_L:
    case insn_putfield_B:
    case insn_putfield_C:
    case insn_putfield_S:
    case insn_putfield_I:
    case insn_putfield_J:
    case insn_putfield_F:
    case insn_putfield_D:
    case insn_putfield_Z:
    case insn_putfield_L:
    case insn_getstatic_B:
    case insn_getstatic_C:
    case insn_getstatic_S:
    case insn_getstatic_I:
    case insn_getstatic_J:
    case insn_getstatic_F:
    case insn_getstatic_D:
    case insn_getstatic_Z:
    case insn_getstatic_L:
    case insn_putstatic_B:
    case insn_putstatic_C:
    case insn_putstatic_S:
    case insn_putstatic_I:
    case insn_putstatic_J:
    case insn_putstatic_F:
    case insn_putstatic_D:
    case insn_putstatic_Z:
    case insn_putstatic_L:
      shape.features |= PROFILE_FEATURE_FIELD;
      break;
    case insn_aaload:
    case insn_aastore:
    case insn_arraylength:
    case insn_baload:
    case insn_bastore:
    case insn_caload:
    case insn_castore:
    case insn_daload:
    case insn_dastore:
    case insn_faload:
    case insn_fastore:
    case insn_iaload:
    case insn_iastore:
    case insn_laload:
    case insn_lastore:
    case insn_saload:
    case insn_sastore:
      shape.features |= PROFILE_FEATURE_ARRAY;
      break;
    case insn_athrow:
      shape.features |= PROFILE_FEATURE_THROW;
      break;
    case insn_monitorenter:
    case insn_monitorexit:
      shape.features |= PROFILE_FEATURE_MONITOR;
      break;
    case insn_tableswitch:
    case insn_lookupswitch:
      shape.features |= PROFILE_FEATURE_SWITCH;
      break;
    case insn_checkcast:
    case insn_checkcast_resolved:
    case insn_instanceof:
    case insn_instanceof_resolved:
      shape.features |= PROFILE_FEATURE_TYPE_CHECK;
      break;
    default:
      break;
    }
    if (is_floating_point(kind)) {
      shape.features |= PROFILE_FEATURE_FLOATING_POINT;
    }
    if (is_wide_value(kind)) {
      shape.features |= PROFILE_FEATURE_WIDE_VALUE;
    }
    if (is_division(kind)) {
      shape.features |= PROFILE_FEATURE_DIVISION;
    }
  }
  return shape;
}

static void touch_method(profiler *prof, cp_method *method) {
  if (method->profile_epoch == prof->epoch) {
    return;
  }

  method->profile_epoch = prof->epoch;
  method->profile_invocations = 0;
  method->profile_bytecodes = 0;
  arrput(prof->methods, method);
}

void profiler_record_invocation(vm_thread *thread, cp_method *method) {
  profiler *prof = thread->profiler;
  if (!prof) {
    return;
  }

  touch_method(prof, method);
  method->profile_invocations++;
}

void profiler_record_bytecode(vm_thread *thread, cp_method *method, insn_code_kind opcode) {
  profiler *prof = thread->profiler;
  if (!prof) {
    return;
  }

  touch_method(prof, method);
  method->profile_bytecodes++;
  prof->opcode_counts[opcode]++;
}

profiler *launch_profiler(vm_thread *thread) {
  if (thread->profiler) {
    fprintf(stderr, "Thread already has a profiler\n");
    return nullptr;
  }

  profiler *prof = calloc(1, sizeof(profiler));
  prof->thread = thread;
  prof->epoch = atomic_fetch_add(&next_epoch, 1);
  if (prof->epoch == 0) {
    // A wrap is not realistic in a browser session, but keep zero reserved for
    // methods that have never been observed.
    prof->epoch = atomic_fetch_add(&next_epoch, 1);
  }
  thread->profiler = prof;
  return prof;
}

void finish_profiler(profiler *prof) {
  if (!prof || prof->finished) {
    return;
  }
  prof->thread->profiler = nullptr;
  prof->finished = true;
}

char *read_profiler(profiler *prof) {
  if (!prof) {
    return nullptr;
  }
  finish_profiler(prof);

  // Tab-separated output keeps the engine boundary small and deterministic.
  // Class, method, and descriptor names cannot contain tabs or newlines.
  string_builder result;
  string_builder_init(&result);
  for (int opcode = 0; opcode < MAX_INSN_KIND; ++opcode) {
    if (prof->opcode_counts[opcode]) {
      string_builder_append(&result, "#opcode\t%s\t%llu\n", insn_code_to_string(opcode),
                            (unsigned long long)prof->opcode_counts[opcode]);
    }
  }
  for (int i = 0; i < arrlen(prof->methods); ++i) {
    cp_method *method = prof->methods[i];
    const attribute_code *code = method->code;
    method_shape shape = inspect_method_shape(method);
    string_builder_append(
        &result, "%.*s\t%.*s\t%.*s\t%llu\t%llu\t%d\t%d\t%d\t%d\t%d\t%u\t%u\t%u\n",
        fmt_slice(method->my_class->name), fmt_slice(method->name),
        fmt_slice(method->unparsed_descriptor), (unsigned long long)method->profile_invocations,
        (unsigned long long)method->profile_bytecodes, !!(method->access_flags & ACCESS_NATIVE),
        code ? code->insn_count : 0, code ? code->max_stack : 0, code ? code->max_locals : 0,
        code && code->exception_table ? code->exception_table->entries_count : 0, shape.features,
        shape.branches, shape.call_sites);
  }

  arrfree(prof->methods);
  free(prof);
  return result.data;
}
