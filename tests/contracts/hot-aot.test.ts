import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("hot AOT remains a generated, default-off engine experiment", () => {
  const generator = read("scripts/java/GenerateHotAot.java");
  const generated = read("engine/bjvm/vm/generated_hot_aot.inc");
  const publicEngine = read("src/engine.ts");
  const embeddedEngine = read("engine/bjvm/js/bjvm2.ts");

  assert.match(generator, /ClassFile\.of\(\)\.parse/u);
  assert.match(generator, /computeStackHeights/u);
  assert.match(generator, /inconsistent AOT operand-stack height/u);
  assert.match(
    generated,
    /Pinned OpenJDK class input SHA-256: [0-9a-f]{64}/u,
  );
  assert.equal(
    [...generated.matchAll(/static hot_aot_outcome hot_aot_/gu)].length,
    22,
  );
  assert.match(generator, /FieldInstruction/u);
  assert.match(generator, /STRING_CODER/u);
  assert.match(generator, /STRING_IS_LATIN1/u);
  assert.match(generated, /resolve_generated_hot_aot_field/u);
  assert.doesNotMatch(generated, /coder.*byte_offset\\s*=\\s*\\d+/u);
  assert.match(generator, /ArrayStoreInstruction/u);
  assert.match(generator, /ConvertInstruction/u);
  assert.match(generator, /case ISUB/u);
  assert.match(generator, /case ISHR/u);
  assert.match(generator, /case IOR/u);
  assert.match(generator, /case IUSHR/u);
  assert.match(generator, /case INEG/u);
  assert.match(generator, /STRING_LATIN1_CHAR_AT/u);
  assert.match(generator, /STRING_LATIN1_LAST_INDEX_OF_CHAR/u);
  assert.match(generator, /JAVAC_CONVERT_CHARS2UTF/u);
  assert.match(generator, /java\/lang\/String/u);
  assert.match(generator, /checkIndex/u);
  assert.doesNotMatch(generated, /aot_sp/u);

  assert.match(publicEngine, /experiments\?: \{/u);
  assert.match(publicEngine, /hotAot\?: boolean/u);
  assert.match(
    publicEngine,
    /experimentalHotAot: this\.options\.experiments\?\.hotAot/u,
  );
  assert.match(embeddedEngine, /experimentalHotAot\?: boolean/u);
  assert.match(
    embeddedEngine,
    /if \(options\.experimentalHotAot\) \{/u,
  );
});

test("hot AOT patches only admitted call sites and preserves fallback", () => {
  const interpreter = read("engine/bjvm/vm/interpreter2.c");

  assert.match(
    interpreter,
    /identify_generated_hot_aot\(method\) != HOT_AOT_NONE/u,
  );
  assert.match(interpreter, /inst->kind = insn_hot_aot/u);
  assert.match(interpreter, /ordinary Java calls pay no AOT dispatch cost/u);
  assert.match(interpreter, /outcome == HOT_AOT_FALLBACK/u);
  assert.match(
    interpreter,
    /push_frame\(thread, method, args, insn->args\)/u,
  );
  assert.match(
    interpreter,
    /Instance AOT is attempted only after ordinary JVM receiver validation/u,
  );
  assert.match(
    interpreter,
    /AttemptInstanceHotAot\(thread, receiver_method, sp - insn->args\)/u,
  );
  assert.match(
    interpreter,
    /experimental_hot_aot_kind_successes\[kind\]\+\+/u,
  );
});
