import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { runPromiseExit } from "effect/Effect";

/**
 * Promise convenience boundary that preserves Effect's typed failure value.
 *
 * Effect.runPromise intentionally reports failure as a FiberFailure. Browser
 * consumers conventionally classify AbortError and the exported tagged errors
 * directly, so this boundary unwraps expected failures while still surfacing
 * defects and interruption.
 */
export async function runTraceJVMEffect<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> {
  const exit = await runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  throw Cause.squash(exit.cause);
}
