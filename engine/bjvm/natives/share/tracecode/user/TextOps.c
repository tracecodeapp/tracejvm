#include <limits.h>
#include <natives-dsl.h>
#include <objects.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Latin1 text-assembly fast paths for the embedder's Java helper runtime
// (tracecode.user.TextOps). Every native here returns null on any input it
// cannot handle exactly; the Java caller falls back to its interpreted
// implementation, so these must be drop-in byte-identical for the inputs
// they do accept.

static stack_value json_number_array(
    vm_thread *thread,
    obj_header *array,
    s32 emitted,
    s32 total,
    bool wide) {
  if (!array)
    return value_null();
  if (emitted < 0 || emitted > ArrayLength(array) || total < emitted)
    return value_null();
  // Worst case per element: "-9223372036854775808" (20) plus a comma, plus
  // room for the truncation marker object.
  size_t capacity = (size_t)emitted * (wide ? 22 : 13) + 64;
  char *buffer = malloc(capacity);
  if (!buffer)
    return value_null();
  size_t length = 0;
  buffer[length++] = '[';
  if (wide) {
    s64 const *data = (s64 const *)ArrayData(array);
    for (s32 index = 0; index < emitted; index++) {
      if (index > 0)
        buffer[length++] = ',';
      length += (size_t)snprintf(
          buffer + length, capacity - length, "%lld", (long long)data[index]);
    }
  } else {
    s32 const *data = (s32 const *)ArrayData(array);
    for (s32 index = 0; index < emitted; index++) {
      if (index > 0)
        buffer[length++] = ',';
      length += (size_t)snprintf(
          buffer + length, capacity - length, "%d", (int)data[index]);
    }
  }
  if (emitted < total) {
    // Mirror of the Java-side array truncation marker.
    if (emitted > 0)
      buffer[length++] = ',';
    length += (size_t)snprintf(
        buffer + length, capacity - length,
        "{\"__truncated__\":true,\"remaining\":%d}", (int)(total - emitted));
  }
  buffer[length++] = ']';
  // All array reads are complete: the allocation below may move `array`.
  obj_header *result = MakeJStringFromData(
      thread, (slice){.chars = buffer, .len = length}, STRING_CODER_LATIN1);
  free(buffer);
  if (!result)
    return value_null();
  return (stack_value){.obj = result};
}

DECLARE_NATIVE(
    "tracecode/user", TextOps, jsonIntArray0, "([III)Ljava/lang/String;") {
  return json_number_array(
      thread, args[0].handle->obj, args[1].i, args[2].i, false);
}

DECLARE_NATIVE(
    "tracecode/user", TextOps, jsonLongArray0, "([JII)Ljava/lang/String;") {
  return json_number_array(
      thread, args[0].handle->obj, args[1].i, args[2].i, true);
}

// Latin1 JSON string escape: quote, backslash, \n \r \t, other control chars
// as lowercase \u%04x, everything else (including >= 0x80) verbatim. Returns
// a quoted latin1 jstring, or null on allocation failure.
static stack_value json_escape_latin1(
    vm_thread *thread, u8 const *bytes, s32 length) {
  size_t capacity = (size_t)length * 6 + 3;
  char *buffer = malloc(capacity);
  if (!buffer)
    return value_null();
  size_t out = 0;
  buffer[out++] = '"';
  for (s32 index = 0; index < length; index++) {
    u8 ch = bytes[index];
    switch (ch) {
    case '"':
      buffer[out++] = '\\';
      buffer[out++] = '"';
      break;
    case '\\':
      buffer[out++] = '\\';
      buffer[out++] = '\\';
      break;
    case '\n':
      buffer[out++] = '\\';
      buffer[out++] = 'n';
      break;
    case '\r':
      buffer[out++] = '\\';
      buffer[out++] = 'r';
      break;
    case '\t':
      buffer[out++] = '\\';
      buffer[out++] = 't';
      break;
    default:
      if (ch < 0x20) {
        out += (size_t)snprintf(buffer + out, capacity - out, "\\u%04x", ch);
      } else {
        buffer[out++] = ch;
      }
    }
  }
  buffer[out++] = '"';
  // Source bytes fully consumed before this allocation may move objects.
  obj_header *result = MakeJStringFromData(
      thread, (slice){.chars = buffer, .len = out}, STRING_CODER_LATIN1);
  free(buffer);
  if (!result)
    return value_null();
  return (stack_value){.obj = result};
}

static stack_value latin1_jstring(vm_thread *thread, char const *text) {
  obj_header *result = MakeJStringFromData(
      thread, (slice){.chars = (char *)text, .len = strlen(text)},
      STRING_CODER_LATIN1);
  if (!result)
    return value_null();
  return (stack_value){.obj = result};
}

DECLARE_NATIVE(
    "tracecode/user", TextOps, jsonEscape0,
    "(Ljava/lang/String;)Ljava/lang/String;") {
  obj_header *value = args[0].handle->obj;
  if (!value)
    return value_null();
  if (((struct native_String *)value)->coder != STRING_CODER_LATIN1)
    return value_null();
  obj_header *raw = RawStringData(thread, value);
  return json_escape_latin1(
      thread, (u8 const *)ArrayData(raw), ArrayLength(raw));
}

// JSON rendering for the final scalar box classes. Anything not recognized
// byte-for-byte returns null and the Java cascade handles it (notably
// Double/Float, whose toString formatting is not replicated here, and
// UTF16-coded strings/chars).
DECLARE_NATIVE(
    "tracecode/user", TextOps, jsonScalar0,
    "(Ljava/lang/Object;)Ljava/lang/String;") {
  obj_header *value = args[0].handle->obj;
  if (!value)
    return value_null();
  slice class_name = value->descriptor->name;
  if (utf8_equals(class_name, "java/lang/Integer")) {
    char text[16];
    snprintf(text, sizeof(text), "%d", (int)LoadFieldInt(value, "value"));
    return latin1_jstring(thread, text);
  }
  if (utf8_equals(class_name, "java/lang/String")) {
    if (((struct native_String *)value)->coder != STRING_CODER_LATIN1)
      return value_null();
    obj_header *raw = RawStringData(thread, value);
    return json_escape_latin1(
        thread, (u8 const *)ArrayData(raw), ArrayLength(raw));
  }
  if (utf8_equals(class_name, "java/lang/Boolean")) {
    return latin1_jstring(
        thread, LoadFieldBoolean(value, "value") ? "true" : "false");
  }
  if (utf8_equals(class_name, "java/lang/Long")) {
    char text[24];
    snprintf(
        text, sizeof(text), "%lld", (long long)LoadFieldLong(value, "value"));
    return latin1_jstring(thread, text);
  }
  if (utf8_equals(class_name, "java/lang/Character")) {
    jchar ch = LoadFieldChar(value, "value");
    if (ch > 0xFF)
      return value_null();
    u8 byte = (u8)ch;
    return json_escape_latin1(thread, &byte, 1);
  }
  if (utf8_equals(class_name, "java/lang/Short")) {
    char text[8];
    snprintf(
        text, sizeof(text), "%d",
        (int)(s16)__obj_load_field(value, STR("value"), STR("S")).i);
    return latin1_jstring(thread, text);
  }
  if (utf8_equals(class_name, "java/lang/Byte")) {
    char text[8];
    snprintf(text, sizeof(text), "%d", (int)(s8)LoadFieldByte(value, "value"));
    return latin1_jstring(thread, text);
  }
  return value_null();
}

// Borrowed view of a latin1 string's bytes. ok=false when the reference is
// non-null but not a latin1-coded string (UTF16 → caller must fall back).
typedef struct {
  u8 const *bytes;
  s32 length;
  bool present;
  bool ok;
} latin1_view;

static latin1_view view_latin1(vm_thread *thread, obj_header *string) {
  latin1_view view = {0};
  if (!string) {
    view.ok = true;
    return view;
  }
  if (((struct native_String *)string)->coder != STRING_CODER_LATIN1)
    return view;
  obj_header *raw = RawStringData(thread, string);
  view.bytes = (u8 const *)ArrayData(raw);
  view.length = ArrayLength(raw);
  view.present = true;
  view.ok = true;
  return view;
}

static size_t write_json_escaped(char *out, latin1_view view) {
  size_t length = 0;
  out[length++] = '"';
  for (s32 index = 0; index < view.length; index++) {
    u8 ch = view.bytes[index];
    switch (ch) {
    case '"':
      out[length++] = '\\';
      out[length++] = '"';
      break;
    case '\\':
      out[length++] = '\\';
      out[length++] = '\\';
      break;
    case '\n':
      out[length++] = '\\';
      out[length++] = 'n';
      break;
    case '\r':
      out[length++] = '\\';
      out[length++] = 'r';
      break;
    case '\t':
      out[length++] = '\\';
      out[length++] = 't';
      break;
    default:
      if (ch < 0x20) {
        length += (size_t)sprintf(out + length, "\\u%04x", ch);
      } else {
        out[length++] = ch;
      }
    }
  }
  out[length++] = '"';
  return length;
}

static size_t write_verbatim(char *out, char const *text, size_t text_length) {
  memcpy(out, text, text_length);
  return text_length;
}

// Assembles one line-oriented JSON record for the embedder's text protocol:
//   HEADER,"line":L[,"function":FN][,"target":{"variable":NAME
//   [,"path":PATH][,"indexSources":IS]}][,"value":VAL]SUFFIX}
// The header carries the record opening (including its opening brace), so
// the protocol vocabulary stays on the Java side; name and functionName are
// escaped; path/indexSources/value/suffix are inserted verbatim. Returns
// null (Java falls back) on any UTF16 input.
DECLARE_NATIVE(
    "tracecode/user", TextOps, buildRecord0,
    "(Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;"
    "Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;"
    "Ljava/lang/String;)Ljava/lang/String;") {
  latin1_view header = view_latin1(thread, args[0].handle->obj);
  s32 line = args[1].i;
  latin1_view name = view_latin1(thread, args[2].handle->obj);
  latin1_view path = view_latin1(thread, args[3].handle->obj);
  latin1_view sources = view_latin1(thread, args[4].handle->obj);
  latin1_view value_json = view_latin1(thread, args[5].handle->obj);
  latin1_view function = view_latin1(thread, args[6].handle->obj);
  latin1_view suffix = view_latin1(thread, args[7].handle->obj);
  if (!header.ok || !name.ok || !path.ok || !sources.ok || !value_json.ok ||
      !function.ok || !suffix.ok || !header.present)
    return value_null();

  size_t capacity = 96 + header.length + (size_t)name.length * 6 +
                    (size_t)function.length * 6 + path.length +
                    sources.length + value_json.length + suffix.length;
  char *buffer = malloc(capacity);
  if (!buffer)
    return value_null();
  size_t out = 0;
  out += write_verbatim(buffer + out, (char const *)header.bytes, header.length);
  out += (size_t)sprintf(buffer + out, ",\"line\":%d", (int)line);
  if (function.present) {
    out += (size_t)sprintf(buffer + out, ",\"function\":");
    out += write_json_escaped(buffer + out, function);
  }
  if (name.present) {
    out += (size_t)sprintf(buffer + out, ",\"target\":{\"variable\":");
    out += write_json_escaped(buffer + out, name);
    if (path.present) {
      out += (size_t)sprintf(buffer + out, ",\"path\":");
      out += write_verbatim(buffer + out, (char const *)path.bytes, path.length);
    }
    if (sources.present) {
      out += (size_t)sprintf(buffer + out, ",\"indexSources\":");
      out += write_verbatim(
          buffer + out, (char const *)sources.bytes, sources.length);
    }
    buffer[out++] = '}';
  }
  if (value_json.present) {
    out += (size_t)sprintf(buffer + out, ",\"value\":");
    out += write_verbatim(
        buffer + out, (char const *)value_json.bytes, value_json.length);
  }
  if (suffix.present) {
    out += write_verbatim(
        buffer + out, (char const *)suffix.bytes, suffix.length);
  }
  buffer[out++] = '}';
  // All source reads are complete: the allocation below may move objects.
  obj_header *result = MakeJStringFromData(
      thread, (slice){.chars = buffer, .len = out}, STRING_CODER_LATIN1);
  free(buffer);
  if (!result)
    return value_null();
  return (stack_value){.obj = result};
}

// buildRecord0 variant for single-int-index member accesses: the path is
// rendered as [index] in C so Java never builds that string.
DECLARE_NATIVE(
    "tracecode/user", TextOps, buildIndexedRecord0,
    "(Ljava/lang/String;ILjava/lang/String;ILjava/lang/String;"
    "Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;") {
  latin1_view header = view_latin1(thread, args[0].handle->obj);
  s32 line = args[1].i;
  latin1_view name = view_latin1(thread, args[2].handle->obj);
  s32 index = args[3].i;
  latin1_view sources = view_latin1(thread, args[4].handle->obj);
  latin1_view value_json = view_latin1(thread, args[5].handle->obj);
  latin1_view suffix = view_latin1(thread, args[6].handle->obj);
  if (!header.ok || !name.ok || !sources.ok || !value_json.ok || !suffix.ok ||
      !header.present || !name.present || !value_json.present)
    return value_null();

  size_t capacity = 128 + header.length + (size_t)name.length * 6 +
                    sources.length + value_json.length + suffix.length;
  char *buffer = malloc(capacity);
  if (!buffer)
    return value_null();
  size_t out = 0;
  out += write_verbatim(buffer + out, (char const *)header.bytes, header.length);
  out += (size_t)sprintf(
      buffer + out, ",\"line\":%d,\"target\":{\"variable\":", (int)line);
  out += write_json_escaped(buffer + out, name);
  out += (size_t)sprintf(buffer + out, ",\"path\":[%d]", (int)index);
  if (sources.present) {
    out += (size_t)sprintf(buffer + out, ",\"indexSources\":");
    out += write_verbatim(
        buffer + out, (char const *)sources.bytes, sources.length);
  }
  out += (size_t)sprintf(buffer + out, "},\"value\":");
  out += write_verbatim(
      buffer + out, (char const *)value_json.bytes, value_json.length);
  if (suffix.present) {
    out += write_verbatim(
        buffer + out, (char const *)suffix.bytes, suffix.length);
  }
  buffer[out++] = '}';
  // All source reads are complete: the allocation below may move objects.
  obj_header *result = MakeJStringFromData(
      thread, (slice){.chars = buffer, .len = out}, STRING_CODER_LATIN1);
  free(buffer);
  if (!result)
    return value_null();
  return (stack_value){.obj = result};
}

DECLARE_NATIVE(
    "tracecode/user", TextOps, encodeLinesUtf8, "([Ljava/lang/String;I)[B") {
  obj_header *lines = args[0].handle->obj;
  if (!lines)
    return value_null();
  s32 count = args[1].i;
  if (count < 0 || count > ArrayLength(lines))
    return value_null();

  // Pass 1: size the UTF-8 output. Latin1-coded strings only — anything
  // UTF16-coded punts the whole block back to the Java encoder.
  s64 total = 0;
  for (s32 index = 0; index < count; index++) {
    obj_header *line = ReferenceArrayLoad(lines, index);
    if (!line)
      return value_null();
    struct native_String *string = (struct native_String *)line;
    if (string->coder != STRING_CODER_LATIN1)
      return value_null();
    obj_header *raw = string->value;
    s32 raw_length = ArrayLength(raw);
    u8 const *bytes = (u8 const *)ArrayData(raw);
    total += (s64)raw_length + 1; // trailing '\n'
    for (s32 offset = 0; offset < raw_length; offset++)
      total += bytes[offset] >> 7; // latin1 >= 0x80 becomes two UTF-8 bytes
  }
  if (total > INT_MAX)
    return value_null();

  u8 *buffer = malloc(total > 0 ? (size_t)total : 1);
  if (!buffer)
    return value_null();
  size_t length = 0;
  for (s32 index = 0; index < count; index++) {
    struct native_String *string =
        (struct native_String *)ReferenceArrayLoad(lines, index);
    obj_header *raw = string->value;
    s32 raw_length = ArrayLength(raw);
    u8 const *bytes = (u8 const *)ArrayData(raw);
    for (s32 offset = 0; offset < raw_length; offset++) {
      u8 latin1 = bytes[offset];
      if (latin1 < 0x80) {
        buffer[length++] = latin1;
      } else {
        buffer[length++] = (u8)(0xC0 | (latin1 >> 6));
        buffer[length++] = (u8)(0x80 | (latin1 & 0x3F));
      }
    }
    buffer[length++] = '\n';
  }

  // All string reads are complete: the allocation below may move objects.
  obj_header *result =
      CreatePrimitiveArray1D(thread, TYPE_KIND_BYTE, (int)length);
  if (!result) {
    free(buffer);
    return value_null();
  }
  memcpy(ArrayData(result), buffer, length);
  free(buffer);
  return (stack_value){.obj = result};
}
