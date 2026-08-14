import java.io.IOException;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeElement;
import java.lang.classfile.CodeModel;
import java.lang.classfile.Instruction;
import java.lang.classfile.Label;
import java.lang.classfile.MethodModel;
import java.lang.classfile.Opcode;
import java.lang.classfile.TypeKind;
import java.lang.classfile.instruction.ArrayLoadInstruction;
import java.lang.classfile.instruction.ArrayStoreInstruction;
import java.lang.classfile.instruction.BranchInstruction;
import java.lang.classfile.instruction.ConstantInstruction;
import java.lang.classfile.instruction.ConvertInstruction;
import java.lang.classfile.instruction.FieldInstruction;
import java.lang.classfile.instruction.IncrementInstruction;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.LabelTarget;
import java.lang.classfile.instruction.LoadInstruction;
import java.lang.classfile.instruction.OperatorInstruction;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.classfile.instruction.StoreInstruction;
import java.lang.constant.ConstantDesc;
import java.lang.reflect.AccessFlag;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Compiles a deliberately small, auditable Java bytecode subset into C.
 *
 * <p>This is an exploratory build-time compiler, not a second JVM. Every
 * generated method is selected by an explicit allowlist, parsed from the
 * pinned OpenJDK 23 image, and falls back to the interpreter when its
 * preconditions are not met.
 */
public final class GenerateHotAot {
  private record MethodSpec(
      String id,
      String owner,
      String name,
      String descriptor,
      int argumentSlots,
      Integer fallbackArraySlot,
      String fallbackGuard) {}

  private static final List<MethodSpec> SPECS =
      List.of(
          new MethodSpec(
              "BYTE_TO_UNSIGNED_INT",
              "java/lang/Byte",
              "toUnsignedInt",
              "(B)I",
              1,
              null,
              null),
          new MethodSpec(
              "STRING_LATIN1_EQUALS",
              "java/lang/StringLatin1",
              "equals",
              "([B[B)Z",
              2,
              0,
              "ArrayLength(args[0].obj) > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "ARRAYS_SUPPORT_UNSIGNED_HASH_CODE",
              "jdk/internal/util/ArraysSupport",
              "unsignedHashCode",
              "(I[BII)I",
              4,
              1,
              "args[3].i > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "STRING_LATIN1_INDEX_OF",
              "java/lang/StringLatin1",
              "indexOf",
              "([BI[BII)I",
              5,
              null,
              "args[1].i > HOT_AOT_MAX_LOOP_ITERATIONS"
                  + " || args[3].i > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "STRING_LATIN1_LAST_INDEX_OF_STRING",
              "java/lang/StringLatin1",
              "lastIndexOf",
              "([BI[BII)I",
              5,
              null,
              "args[1].i > HOT_AOT_MAX_LOOP_ITERATIONS"
                  + " || args[3].i > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "STRING_UTF16_COMPRESS_CHARS",
              "java/lang/StringUTF16",
              "compress",
              "([CI[BII)I",
              5,
              null,
              "args[4].i > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "STRING_LATIN1_INDEX_OF_CHAR",
              "java/lang/StringLatin1",
              "indexOfChar",
              "([BIII)I",
              4,
              null,
              "args[3].i > args[2].i"
                  + " && ((u32)args[3].i - (u32)args[2].i)"
                  + " > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "STRING_CODING_COUNT_POSITIVES",
              "java/lang/StringCoding",
              "countPositives",
              "([BII)I",
              3,
              null,
              "args[2].i > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "MATH_MIN_INT",
              "java/lang/Math",
              "min",
              "(II)I",
              2,
              null,
              null),
          new MethodSpec(
              "CHARACTER_CHAR_COUNT",
              "java/lang/Character",
              "charCount",
              "(I)I",
              1,
              null,
              null),
          new MethodSpec(
              "STRING_LATIN1_CAN_ENCODE_CHAR",
              "java/lang/StringLatin1",
              "canEncode",
              "(C)Z",
              1,
              null,
              null),
          new MethodSpec(
              "STRING_LATIN1_CAN_ENCODE_INT",
              "java/lang/StringLatin1",
              "canEncode",
              "(I)Z",
              1,
              null,
              null),
          new MethodSpec(
              "MATH_MAX_INT",
              "java/lang/Math",
              "max",
              "(II)I",
              2,
              null,
              null),
          new MethodSpec(
              "CHARACTER_IS_SURROGATE",
              "java/lang/Character",
              "isSurrogate",
              "(C)Z",
              1,
              null,
              null),
          new MethodSpec(
              "INTEGER_BIT_COUNT",
              "java/lang/Integer",
              "bitCount",
              "(I)I",
              1,
              null,
              null),
          new MethodSpec(
              "INTEGER_STRING_SIZE",
              "java/lang/Integer",
              "stringSize",
              "(I)I",
              1,
              null,
              null),
          new MethodSpec(
              "STRING_UTF16_CODER_FROM_ARRAY_LEN",
              "java/lang/StringUTF16",
              "coderFromArrayLen",
              "([BI)B",
              2,
              null,
              null),
          new MethodSpec(
              "STRING_CODER",
              "java/lang/String",
              "coder",
              "()B",
              1,
              null,
              null),
          new MethodSpec(
              "STRING_IS_LATIN1",
              "java/lang/String",
              "isLatin1",
              "()Z",
              1,
              null,
              null),
          new MethodSpec(
              "STRING_LATIN1_CHAR_AT",
              "java/lang/StringLatin1",
              "charAt",
              "([BI)C",
              2,
              null,
              null),
          new MethodSpec(
              "STRING_LATIN1_LAST_INDEX_OF_CHAR",
              "java/lang/StringLatin1",
              "lastIndexOf",
              "([BII)I",
              3,
              0,
              "ArrayLength(args[0].obj) > HOT_AOT_MAX_LOOP_ITERATIONS"),
          new MethodSpec(
              "JAVAC_CONVERT_CHARS2UTF",
              "com/sun/tools/javac/util/Convert",
              "chars2utf",
              "([CI[BII)I",
              5,
              null,
              "args[4].i > HOT_AOT_MAX_LOOP_ITERATIONS"));

  private record CompiledMethod(
      MethodSpec spec, int maxLocals, int maxStack, int cachedFields, String body) {}

  private record CompiledCode(int cachedFields, String body) {}

  private GenerateHotAot() {}

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      throw new IllegalArgumentException(
          "usage: GenerateHotAot <extracted-class-root>... <output.inc>");
    }

    List<Path> classRoots =
        Arrays.stream(args, 0, args.length - 1).map(Path::of).toList();
    Path output = Path.of(args[args.length - 1]);
    List<CompiledMethod> methods = new ArrayList<>();
    Map<String, Map<String, Integer>> fieldSlotsByOwner = new LinkedHashMap<>();
    MessageDigest digest = MessageDigest.getInstance("SHA-256");

    for (MethodSpec spec : SPECS) {
      Path classFile = findClass(classRoots, spec.owner());
      byte[] bytes = Files.readAllBytes(classFile);
      digest.update(bytes);
      methods.add(
          compile(
              spec,
              ClassFile.of().parse(bytes),
              fieldSlotsByOwner.computeIfAbsent(spec.owner(), ignored -> new LinkedHashMap<>())));
    }

    String sourceHash = HexFormat.of().formatHex(digest.digest());
    Files.createDirectories(output.getParent());
    Files.writeString(output, render(methods, sourceHash));
  }

  private static Path findClass(List<Path> roots, String owner) {
    List<Path> matches =
        roots.stream()
            .map(root -> root.resolve(owner + ".class"))
            .filter(Files::isRegularFile)
            .toList();
    if (matches.size() != 1) {
      throw new IllegalStateException(
          "expected exactly one class input for " + owner + " but found " + matches);
    }
    return matches.getFirst();
  }

  private static CompiledMethod compile(
      MethodSpec spec, ClassModel model, Map<String, Integer> ownerFieldSlots) {
    String parsedOwner = model.thisClass().asInternalName();
    if (!parsedOwner.equals(spec.owner())) {
      throw new IllegalStateException(
          "expected " + spec.owner() + " but parsed " + parsedOwner);
    }

    MethodModel method =
        model.methods().stream()
            .filter(candidate -> candidate.methodName().stringValue().equals(spec.name()))
            .filter(candidate -> candidate.methodType().stringValue().equals(spec.descriptor()))
            .findFirst()
            .orElseThrow(
                () ->
                    new IllegalStateException(
                        "missing "
                            + spec.owner()
                            + "."
                            + spec.name()
                            + spec.descriptor()));
    CodeModel code =
        method.code().orElseThrow(() -> new IllegalStateException("method has no Code attribute"));
    if (!code.exceptionHandlers().isEmpty()) {
      throw new IllegalStateException("exception tables are outside the first AOT subset");
    }

    boolean isStatic = method.flags().has(AccessFlag.STATIC);
    if (!isStatic && spec.argumentSlots() < 1) {
      throw new IllegalStateException("instance AOT methods must include the receiver argument");
    }
    CompiledCode compiled = compileCode(spec, code, ownerFieldSlots);
    if (compiled.cachedFields() > 2) {
      throw new IllegalStateException(
          "generated AOT method requires "
              + compiled.cachedFields()
              + " cached fields; cp_method currently reserves 2");
    }
    return new CompiledMethod(
        spec,
        code.maxLocals(),
        code.maxStack(),
        compiled.cachedFields(),
        compiled.body());
  }

  private static CompiledCode compileCode(
      MethodSpec spec, CodeModel code, Map<String, Integer> fieldSlots) {
    List<CodeElement> elements = code.elementList();
    Map<Label, Integer> labelIds = new IdentityHashMap<>();
    Map<Label, Integer> labelIndexes = new IdentityHashMap<>();
    int nextLabel = 0;
    for (int index = 0; index < elements.size(); index++) {
      CodeElement element = elements.get(index);
      if (element instanceof LabelTarget target) {
        labelIds.put(target.label(), nextLabel++);
        labelIndexes.put(target.label(), index);
      }
    }
    int[] stackHeights = computeStackHeights(elements, labelIndexes);

    StringBuilder out = new StringBuilder();
    for (int index = 0; index < Math.max(1, code.maxLocals()); index++) {
      out.append("  stack_value local_")
          .append(index)
          .append(" __attribute__((unused)) = {};\n");
    }
    for (int index = 0; index < Math.max(1, code.maxStack()); index++) {
      out.append("  stack_value stack_")
          .append(index)
          .append(" __attribute__((unused)) = {};\n");
    }
    for (int index = 0; index < spec.argumentSlots(); index++) {
      out.append("  local_").append(index).append(" = args[").append(index).append("];\n");
    }

    for (int index = 0; index < elements.size(); index++) {
      CodeElement element = elements.get(index);
      if (element instanceof LabelTarget target) {
        out.append("hot_aot_label_").append(labelId(labelIds, target.label())).append(":\n");
      } else if (element instanceof Instruction instruction) {
        int stackHeight = stackHeights[index];
        if (stackHeight < 0) {
          throw new IllegalStateException("reachable instruction did not have a stack height");
        }
        emitInstruction(out, labelIds, fieldSlots, spec, instruction, stackHeight);
      }
    }
    out.append("  return HOT_AOT_FALLBACK;\n");
    return new CompiledCode(fieldSlots.size(), out.toString());
  }

  private static int[] computeStackHeights(
      List<CodeElement> elements, Map<Label, Integer> labelIndexes) {
    int[] heights = new int[elements.size()];
    Arrays.fill(heights, -1);
    ArrayDeque<Integer> pending = new ArrayDeque<>();
    mergeHeight(heights, pending, 0, 0);

    while (!pending.isEmpty()) {
      int index = pending.removeFirst();
      int height = heights[index];
      CodeElement element = elements.get(index);
      if (!(element instanceof Instruction instruction)) {
        mergeHeight(heights, pending, index + 1, height);
        continue;
      }

      int nextHeight = height + stackDelta(instruction);
      if (nextHeight < 0) {
        throw new IllegalStateException("AOT stack underflow at " + instruction.opcode());
      }
      if (instruction instanceof BranchInstruction branch) {
        Integer target = labelIndexes.get(branch.target());
        if (target == null) {
          throw new IllegalStateException("branch target was not present in the Code element stream");
        }
        mergeHeight(heights, pending, target, nextHeight);
        if (branch.opcode() != Opcode.GOTO && branch.opcode() != Opcode.GOTO_W) {
          mergeHeight(heights, pending, index + 1, nextHeight);
        }
      } else if (!(instruction instanceof ReturnInstruction)) {
        mergeHeight(heights, pending, index + 1, nextHeight);
      }
    }
    return heights;
  }

  private static void mergeHeight(
      int[] heights, ArrayDeque<Integer> pending, int index, int height) {
    if (index >= heights.length) {
      return;
    }
    if (heights[index] == -1) {
      heights[index] = height;
      pending.add(index);
    } else if (heights[index] != height) {
      throw new IllegalStateException(
          "inconsistent AOT operand-stack height at element "
              + index
              + ": "
              + heights[index]
              + " versus "
              + height);
    }
  }

  private static int stackDelta(Instruction instruction) {
    if (instruction instanceof LoadInstruction || instruction instanceof ConstantInstruction) {
      return 1;
    }
    if (instruction instanceof StoreInstruction) {
      return -1;
    }
    if (instruction instanceof IncrementInstruction) {
      return 0;
    }
    if (instruction instanceof ArrayLoadInstruction) {
      return -1;
    }
    if (instruction instanceof ArrayStoreInstruction) {
      return -3;
    }
    if (instruction instanceof ConvertInstruction) {
      return 0;
    }
    if (instruction instanceof OperatorInstruction) {
      return switch (instruction.opcode()) {
        case ARRAYLENGTH, INEG -> 0;
        default -> -1;
      };
    }
    if (instruction instanceof BranchInstruction branch) {
      return switch (branch.opcode()) {
        case GOTO, GOTO_W -> 0;
        case IFEQ, IFNE, IFLT, IFGE, IFGT, IFLE -> -1;
        case IF_ICMPEQ, IF_ICMPNE, IF_ICMPLT, IF_ICMPGE, IF_ICMPGT, IF_ICMPLE -> -2;
        default -> throw unsupported(instruction);
      };
    }
    if (instruction instanceof InvokeInstruction invoke) {
      String owner = invoke.owner().asInternalName();
      String name = invoke.name().stringValue();
      String descriptor = invoke.type().stringValue();
      if (invoke.opcode() == Opcode.INVOKESTATIC
          && owner.equals("java/lang/Byte")
          && name.equals("toUnsignedInt")
          && descriptor.equals("(B)I")) {
        return 0;
      }
      if (invoke.opcode() == Opcode.INVOKESTATIC
          && owner.equals("java/lang/String")
          && name.equals("checkIndex")
          && descriptor.equals("(II)V")) {
        return -2;
      }
      if (invoke.opcode() == Opcode.INVOKESTATIC
          && owner.equals("java/lang/StringLatin1")
          && name.equals("canEncode")
          && descriptor.equals("(I)Z")) {
        return 0;
      }
      if (invoke.opcode() == Opcode.INVOKESTATIC
          && owner.equals("java/lang/Math")
          && name.equals("min")
          && descriptor.equals("(II)I")) {
        return -1;
      }
      throw unsupported(instruction);
    }
    if (instruction instanceof FieldInstruction field) {
      return switch (field.opcode()) {
        case GETSTATIC -> 1;
        case GETFIELD -> 0;
        default -> throw unsupported(instruction);
      };
    }
    if (instruction instanceof ReturnInstruction) {
      return -1;
    }
    throw unsupported(instruction);
  }

  private static void emitInstruction(
      StringBuilder out,
      Map<Label, Integer> labels,
      Map<String, Integer> fieldSlots,
      MethodSpec spec,
      Instruction instruction,
      int stackHeight) {
    Opcode opcode = instruction.opcode();
    if (instruction instanceof LoadInstruction load) {
      requireKind(load.typeKind(), TypeKind.IntType, TypeKind.ReferenceType);
      out.append("  ")
          .append(stack(stackHeight))
          .append(" = ")
          .append(local(load.slot()))
          .append(";\n");
      return;
    }
    if (instruction instanceof StoreInstruction store) {
      requireKind(store.typeKind(), TypeKind.IntType, TypeKind.ReferenceType);
      out.append("  ")
          .append(local(store.slot()))
          .append(" = ")
          .append(stack(stackHeight - 1))
          .append(";\n");
      return;
    }
    if (instruction instanceof ConstantInstruction constant) {
      ConstantDesc value = constant.constantValue();
      if (!(value instanceof Integer intValue)) {
        throw unsupported(instruction);
      }
      out.append("  ").append(stack(stackHeight)).append(".i = ").append(intValue).append(";\n");
      return;
    }
    if (instruction instanceof IncrementInstruction increment) {
      out.append("  ")
          .append(local(increment.slot()))
          .append(".i = (s32)((u32)")
          .append(local(increment.slot()))
          .append(".i + (u32)")
          .append(increment.constant())
          .append(");\n");
      return;
    }
    if (instruction instanceof ArrayLoadInstruction arrayLoad) {
      out.append("  {\n");
      out.append("    s32 index = ").append(stack(stackHeight - 1)).append(".i;\n");
      out.append("    obj_header *array = ").append(stack(stackHeight - 2)).append(".obj;\n");
      out.append("    if (unlikely(!array)) {\n");
      out.append("      raise_null_pointer_exception(thread);\n");
      out.append("      return HOT_AOT_EXCEPTION;\n");
      out.append("    }\n");
      out.append("    s32 length = ArrayLength(array);\n");
      out.append("    if (unlikely(index < 0 || index >= length)) {\n");
      out.append("      raise_array_index_oob_exception(thread, index, length);\n");
      out.append("      return HOT_AOT_EXCEPTION;\n");
      out.append("    }\n");
      switch (arrayLoad.typeKind()) {
        case ByteType ->
            out.append("    ")
                .append(stack(stackHeight - 2))
                .append(".i = (s32)((s8 *)ArrayData(array))[index];\n");
        case CharType ->
            out.append("    ")
                .append(stack(stackHeight - 2))
                .append(".i = (s32)((u16 *)ArrayData(array))[index];\n");
        default -> throw unsupported(instruction);
      }
      out.append("  }\n");
      return;
    }
    if (instruction instanceof ArrayStoreInstruction arrayStore) {
      out.append("  {\n");
      out.append("    obj_header *array = ").append(stack(stackHeight - 3)).append(".obj;\n");
      out.append("    s32 index = ").append(stack(stackHeight - 2)).append(".i;\n");
      out.append("    s32 value = ").append(stack(stackHeight - 1)).append(".i;\n");
      out.append("    if (unlikely(!array)) {\n");
      out.append("      raise_null_pointer_exception(thread);\n");
      out.append("      return HOT_AOT_EXCEPTION;\n");
      out.append("    }\n");
      out.append("    s32 length = ArrayLength(array);\n");
      out.append("    if (unlikely(index < 0 || index >= length)) {\n");
      out.append("      raise_array_index_oob_exception(thread, index, length);\n");
      out.append("      return HOT_AOT_EXCEPTION;\n");
      out.append("    }\n");
      switch (arrayStore.typeKind()) {
        case ByteType ->
            out.append("    ((s8 *)ArrayData(array))[index] = (s8)value;\n");
        case CharType ->
            out.append("    ((u16 *)ArrayData(array))[index] = (u16)value;\n");
        default -> throw unsupported(instruction);
      }
      out.append("  }\n");
      return;
    }
    if (instruction instanceof ConvertInstruction convert) {
      if (convert.fromType() != TypeKind.IntType) {
        throw unsupported(instruction);
      }
      String value = stack(stackHeight - 1);
      switch (convert.toType()) {
        case ByteType ->
            out.append("  ").append(value).append(".i = (s32)(s8)").append(value).append(".i;\n");
        case CharType ->
            out.append("  ").append(value).append(".i = (s32)(u16)").append(value).append(".i;\n");
        default -> throw unsupported(instruction);
      }
      return;
    }
    if (instruction instanceof OperatorInstruction) {
      emitOperator(out, opcode, instruction, stackHeight);
      return;
    }
    if (instruction instanceof BranchInstruction branch) {
      emitBranch(out, labels, branch, stackHeight);
      return;
    }
    if (instruction instanceof InvokeInstruction invoke) {
      String owner = invoke.owner().asInternalName();
      String name = invoke.name().stringValue();
      String descriptor = invoke.type().stringValue();
      if (opcode == Opcode.INVOKESTATIC
          && owner.equals("java/lang/Byte")
          && name.equals("toUnsignedInt")
          && descriptor.equals("(B)I")) {
        out.append("  ").append(stack(stackHeight - 1)).append(".i &= 255;\n");
        return;
      }
      if (opcode == Opcode.INVOKESTATIC
          && owner.equals("java/lang/String")
          && name.equals("checkIndex")
          && descriptor.equals("(II)V")) {
        out.append("  if (unlikely(")
            .append(stack(stackHeight - 2))
            .append(".i < 0 || ")
            .append(stack(stackHeight - 2))
            .append(".i >= ")
            .append(stack(stackHeight - 1))
            .append(".i)) return HOT_AOT_FALLBACK;\n");
        return;
      }
      if (opcode == Opcode.INVOKESTATIC
          && owner.equals("java/lang/StringLatin1")
          && name.equals("canEncode")
          && descriptor.equals("(I)Z")) {
        out.append("  ")
            .append(stack(stackHeight - 1))
            .append(".i = ((u32)")
            .append(stack(stackHeight - 1))
            .append(".i >> 8) == 0;\n");
        return;
      }
      if (opcode == Opcode.INVOKESTATIC
          && owner.equals("java/lang/Math")
          && name.equals("min")
          && descriptor.equals("(II)I")) {
        out.append("  ")
            .append(stack(stackHeight - 2))
            .append(".i = ")
            .append(stack(stackHeight - 2))
            .append(".i <= ")
            .append(stack(stackHeight - 1))
            .append(".i ? ")
            .append(stack(stackHeight - 2))
            .append(".i : ")
            .append(stack(stackHeight - 1))
            .append(".i;\n");
        return;
      }
      throw unsupported(instruction);
    }
    if (instruction instanceof FieldInstruction field) {
      emitFieldRead(out, fieldSlots, spec, field, stackHeight);
      return;
    }
    if (instruction instanceof ReturnInstruction returnInstruction) {
      if (returnInstruction.typeKind() != TypeKind.IntType) {
        throw unsupported(instruction);
      }
      out.append("  result->i = ").append(stack(stackHeight - 1)).append(".i;\n");
      out.append("  return HOT_AOT_SUCCESS;\n");
      return;
    }
    throw unsupported(instruction);
  }

  private static void emitFieldRead(
      StringBuilder out,
      Map<String, Integer> fieldSlots,
      MethodSpec spec,
      FieldInstruction field,
      int stackHeight) {
    Opcode opcode = field.opcode();
    if (opcode != Opcode.GETSTATIC && opcode != Opcode.GETFIELD) {
      throw unsupported(field);
    }

    String owner = field.owner().asInternalName();
    String name = field.name().stringValue();
    String descriptor = field.type().stringValue();
    if (!owner.equals(spec.owner())) {
      throw new IllegalStateException(
          "first field-reading AOT subset only resolves fields on the method owner: "
              + owner
              + "."
              + name);
    }
    if (!descriptor.equals("B") && !descriptor.equals("Z")) {
      throw new IllegalStateException(
          "first field-reading AOT subset only supports byte/boolean fields: " + descriptor);
    }

    String key = owner + "\u0000" + name + "\u0000" + descriptor;
    int slot = fieldSlots.computeIfAbsent(key, ignored -> fieldSlots.size());
    boolean isStatic = opcode == Opcode.GETSTATIC;
    String target = stack(isStatic ? stackHeight : stackHeight - 1);

    out.append("  {\n");
    if (!isStatic) {
      out.append("    obj_header *receiver = ").append(target).append(".obj;\n");
      out.append("    if (unlikely(!receiver)) {\n");
      out.append("      raise_null_pointer_exception(thread);\n");
      out.append("      return HOT_AOT_EXCEPTION;\n");
      out.append("    }\n");
    }
    out.append("    cp_field *field = resolve_generated_hot_aot_field(method, ")
        .append(slot)
        .append(", STR(\"")
        .append(cString(name))
        .append("\"), STR(\"")
        .append(cString(descriptor))
        .append("\"), ")
        .append(isStatic ? "true" : "false")
        .append(");\n");
    out.append("    if (unlikely(!field)) return HOT_AOT_FALLBACK;\n");
    if (isStatic) {
      out.append("    ")
          .append(target)
          .append(" = load_stack_value((void *)field->my_class->static_fields + field->byte_offset,\n")
          .append("                              field->parsed_descriptor.repr_kind);\n");
    } else {
      out.append("    ")
          .append(target)
          .append(" = get_field(receiver, field);\n");
    }
    out.append("  }\n");
  }

  private static void emitOperator(
      StringBuilder out, Opcode opcode, Instruction instruction, int stackHeight) {
    String left = stack(stackHeight - 2);
    String right = stack(stackHeight - 1);
    switch (opcode) {
      case IADD ->
          out.append("  ")
              .append(left)
              .append(".i = (s32)((u32)")
              .append(left)
              .append(".i + (u32)")
              .append(right)
              .append(".i);\n");
      case ISUB ->
          out.append("  ")
              .append(left)
              .append(".i = (s32)((u32)")
              .append(left)
              .append(".i - (u32)")
              .append(right)
              .append(".i);\n");
      case IMUL ->
          out.append("  ")
              .append(left)
              .append(".i = (s32)((u32)")
              .append(left)
              .append(".i * (u32)")
              .append(right)
              .append(".i);\n");
      case IAND ->
          out.append("  ").append(left).append(".i &= ").append(right).append(".i;\n");
      case IOR ->
          out.append("  ").append(left).append(".i |= ").append(right).append(".i;\n");
      case ISHR ->
          out.append("  ")
              .append(left)
              .append(".i = ")
              .append(left)
              .append(".i >> ((u32)")
              .append(right)
              .append(".i & 31);\n");
      case IUSHR ->
          out.append("  ")
              .append(left)
              .append(".i = (s32)((u32)")
              .append(left)
              .append(".i >> ((u32)")
              .append(right)
              .append(".i & 31));\n");
      case INEG -> {
        String value = stack(stackHeight - 1);
        out.append("  ")
            .append(value)
            .append(".i = (s32)(0u - (u32)")
            .append(value)
            .append(".i);\n");
      }
      case ARRAYLENGTH -> {
        String value = stack(stackHeight - 1);
        out.append("  if (unlikely(!").append(value).append(".obj)) {\n");
        out.append("    raise_null_pointer_exception(thread);\n");
        out.append("    return HOT_AOT_EXCEPTION;\n");
        out.append("  }\n");
        out.append("  ")
            .append(value)
            .append(".i = ArrayLength(")
            .append(value)
            .append(".obj);\n");
      }
      default -> throw unsupported(instruction);
    }
  }

  private static void emitBranch(
      StringBuilder out,
      Map<Label, Integer> labels,
      BranchInstruction branch,
      int stackHeight) {
    String target = "hot_aot_label_" + labelId(labels, branch.target());
    switch (branch.opcode()) {
      case GOTO, GOTO_W -> out.append("  goto ").append(target).append(";\n");
      case IFEQ, IFNE, IFLT, IFGE, IFGT, IFLE -> {
        String operator =
            switch (branch.opcode()) {
              case IFEQ -> "==";
              case IFNE -> "!=";
              case IFLT -> "<";
              case IFGE -> ">=";
              case IFGT -> ">";
              case IFLE -> "<=";
              default -> throw new AssertionError();
            };
        out.append("  if (")
            .append(stack(stackHeight - 1))
            .append(".i ")
            .append(operator)
            .append(" 0) goto ")
            .append(target)
            .append(";\n");
      }
      case IF_ICMPEQ, IF_ICMPNE, IF_ICMPLT, IF_ICMPGE, IF_ICMPGT, IF_ICMPLE -> {
        String operator =
            switch (branch.opcode()) {
              case IF_ICMPEQ -> "==";
              case IF_ICMPNE -> "!=";
              case IF_ICMPLT -> "<";
              case IF_ICMPGE -> ">=";
              case IF_ICMPGT -> ">";
              case IF_ICMPLE -> "<=";
              default -> throw new AssertionError();
            };
        out.append("  if (")
            .append(stack(stackHeight - 2))
            .append(".i ")
            .append(operator)
            .append(" ")
            .append(stack(stackHeight - 1))
            .append(".i) goto ")
            .append(target)
            .append(";\n");
      }
      default -> throw unsupported(branch);
    }
  }

  private static String render(List<CompiledMethod> methods, String sourceHash) {
    StringBuilder out = new StringBuilder();
    out.append("/* Generated by scripts/java/GenerateHotAot.java. Do not edit. */\n");
    out.append("/* Pinned OpenJDK class input SHA-256: ").append(sourceHash).append(" */\n\n");
    out.append("typedef enum : u8 {\n");
    out.append("  HOT_AOT_UNCLASSIFIED = 0,\n");
    out.append("  HOT_AOT_NONE,\n");
    for (CompiledMethod method : methods) {
      out.append("  HOT_AOT_").append(method.spec().id()).append(",\n");
    }
    out.append("  HOT_AOT_KIND_COUNT,\n");
    out.append("} hot_aot_kind;\n\n");
    out.append("typedef enum : u8 {\n");
    out.append("  HOT_AOT_FALLBACK = 0,\n");
    out.append("  HOT_AOT_SUCCESS,\n");
    out.append("  HOT_AOT_EXCEPTION,\n");
    out.append("} hot_aot_outcome;\n\n");
    out.append("#define HOT_AOT_MAX_LOOP_ITERATIONS 4096\n\n");

    for (CompiledMethod method : methods) {
      out.append("static hot_aot_outcome hot_aot_")
          .append(method.spec().id().toLowerCase())
          .append("(vm_thread *thread, cp_method *method, stack_value *args, stack_value *result) {\n");
      if (method.cachedFields() == 0) {
        out.append("  (void)method;\n");
      }
      out.append(method.body());
      out.append("}\n\n");
    }

    out.append("static u8 classify_generated_hot_aot(cp_method *method) {\n");
    for (int index = 0; index < methods.size(); index++) {
      CompiledMethod method = methods.get(index);
      out.append(index == 0 ? "  if (" : "  } else if (");
      out.append("utf8_equals(method->my_class->name, \"")
          .append(method.spec().owner())
          .append("\") &&\n");
      out.append("      utf8_equals(method->name, \"")
          .append(method.spec().name())
          .append("\") &&\n");
      out.append("      utf8_equals(method->unparsed_descriptor, \"")
          .append(method.spec().descriptor())
          .append("\")) {\n");
      out.append("    return HOT_AOT_").append(method.spec().id()).append(";\n");
    }
    out.append("  }\n");
    out.append("  return HOT_AOT_NONE;\n");
    out.append("}\n\n");

    out.append(
        "static hot_aot_outcome execute_generated_hot_aot(u8 kind, vm_thread *thread,\n"
            + "                                                      cp_method *method, stack_value *args,\n"
            + "                                                      stack_value *result) {\n");
    for (CompiledMethod method : methods) {
      out.append("  if (kind == HOT_AOT_").append(method.spec().id()).append(") {\n");
      if (method.spec().fallbackGuard() != null) {
        if (method.spec().fallbackArraySlot() != null) {
          out.append("    if (unlikely(!args[")
              .append(method.spec().fallbackArraySlot())
              .append("].obj)) {\n");
          out.append("      raise_null_pointer_exception(thread);\n");
          out.append("      return HOT_AOT_EXCEPTION;\n");
          out.append("    }\n");
        }
        out.append("    if (unlikely(")
            .append(method.spec().fallbackGuard())
            .append(")) return HOT_AOT_FALLBACK;\n");
      }
      out.append("    return hot_aot_")
          .append(method.spec().id().toLowerCase())
          .append("(thread, method, args, result);\n");
      out.append("  }\n");
    }
    out.append("  return HOT_AOT_FALLBACK;\n");
    out.append("}\n");
    return out.toString();
  }

  private static int labelId(Map<Label, Integer> labels, Label label) {
    Integer id = labels.get(label);
    if (id == null) {
      throw new IllegalStateException("branch target was not present in the Code element stream");
    }
    return id;
  }

  private static String local(int slot) {
    return "local_" + slot;
  }

  private static String stack(int slot) {
    return "stack_" + slot;
  }

  private static String cString(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }

  private static void requireKind(TypeKind actual, TypeKind... supported) {
    for (TypeKind kind : supported) {
      if (actual == kind) {
        return;
      }
    }
    throw new IllegalStateException("unsupported type kind: " + actual);
  }

  private static IllegalStateException unsupported(Instruction instruction) {
    return new IllegalStateException(
        "unsupported AOT opcode "
            + instruction.opcode()
            + " ("
            + instruction.getClass().getSimpleName()
            + ")");
  }
}
