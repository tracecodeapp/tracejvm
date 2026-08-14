//
// Created by Cowpox on 2/22/25.
//

#ifndef PROFILER_H
#define PROFILER_H

#include "bjvm.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct profiler_s profiler;

// Immediately attaches a deterministic method profiler to the given thread.
// The normal interpreter path pays only a null check while profiling is off.
EMSCRIPTEN_KEEPALIVE
profiler *launch_profiler(vm_thread *thread);

EMSCRIPTEN_KEEPALIVE
void finish_profiler(profiler *profiler);

// Calls finish_profiler, then reads the profiler's data into a heap allocated string and frees the profiler. Should be
// called from the main thread.
EMSCRIPTEN_KEEPALIVE
char *read_profiler(profiler *profiler);

void profiler_record_invocation(vm_thread *thread, cp_method *method);
void profiler_record_bytecode(vm_thread *thread, cp_method *method, insn_code_kind opcode);

#ifdef __cplusplus
}
#endif

#endif // PROFILER_H
