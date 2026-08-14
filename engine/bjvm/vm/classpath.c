#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <zlib.h>

#include "classpath.h"

// Use mmap if we can
#if defined(__linux__) || defined(__APPLE__)
#include <sys/mman.h>
#include <sys/stat.h>
#define USE_MMAP
#endif
#ifdef EMSCRIPTEN
#include <emscripten.h>
#endif

#define TRACEJVM_MAX_JAR_BYTES (128u * 1024u * 1024u)
#define TRACEJVM_MAX_JAR_ENTRIES 32768u
#define TRACEJVM_MAX_JAR_ENTRY_BYTES (32u * 1024u * 1024u)
#define TRACEJVM_MAX_JAR_EXPANDED_BYTES (256ull * 1024ull * 1024ull)

struct loaded_bytes {
  char *bytes;
  u32 length;
  bool needs_free;
};

// Read the entirety of the file using the C filesystem API.
static struct loaded_bytes read_file(FILE *f) {
  fseek(f, 0, SEEK_END);
  size_t length = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *data = malloc(length);
  CHECK(data);
  length = fread(data, 1, length, f);

  DCHECK(length <= UINT32_MAX);
  return (struct loaded_bytes){.bytes = data, .length = (u32)length, .needs_free = true};
}

static char *map_jar(const char *filename, mapped_jar *jar) {
  char error[256];
#ifdef USE_MMAP
  int fd = open(filename, O_RDONLY);
  if (fd == -1)
    goto missing;
  struct stat sb;
  if (fstat(fd, &sb) != 0 || sb.st_size < 0 || (u64)sb.st_size > TRACEJVM_MAX_JAR_BYTES) {
    close(fd);
    snprintf(error, sizeof(error), "JAR file %s exceeds the supported size", filename);
    return strdup(error);
  }
  jar->size_bytes = sb.st_size;
  // Attempt to mmap the file so that we don't read the whole thing for no reason
  const char *file = mmap(NULL, jar->size_bytes, PROT_READ, MAP_PRIVATE, fd, 0);
  if (file == MAP_FAILED) {
    close(fd);
    snprintf(error, sizeof(error), "Failed to mmap file %s", filename);
    return strdup(error);
  }
  jar->data = (char *)file;
  jar->is_mmap = true;
  close(fd);
  return nullptr;
#endif

  // Implementation w/o mmap and not Node
  FILE *f = fopen(filename, "rb");
  if (!f)
    goto missing;
  if (fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return strdup("Failed to inspect JAR size");
  }
  long file_length = ftell(f);
  if (file_length < 0 || (u64)file_length > TRACEJVM_MAX_JAR_BYTES) {
    fclose(f);
    snprintf(error, sizeof(error), "JAR file %s exceeds the supported size", filename);
    return strdup(error);
  }
  rewind(f);
  // Read all into memory
  struct loaded_bytes lb = read_file(f);
  jar->data = lb.bytes;
  jar->size_bytes = lb.length;
  jar->is_mmap = false;
  jar->needs_free = lb.needs_free;
  fclose(f);
  return nullptr;

missing:
  snprintf(error, sizeof(error), "Failed to open file %s", filename);
  return strdup(error);
}

/** ZIP file stuff */

// https://en.wikipedia.org/wiki/ZIP_(file_format)#End_of_central_directory_record_(EOCD)
struct end_of_central_directory_record {
  u32 signature;
  u16 disk_number;
  u16 disk_with_cd;
  u16 num_entries;
  u16 total_entries;
  u32 cd_size;
  u32 cd_offset;
  u16 comment_len;
};

struct central_directory_record {
  u32 header;
  u16 version_made_by;
  u16 version_needed;
  u16 flags;
  u16 compression;
  u16 mod_time;
  u16 mod_date;
  u32 crc32;
  u32 compressed_size;
  u32 uncompressed_size;
  u16 filename_len;
  u16 extra_len;
  u16 comment_len;
  u16 disk_start;
  u16 internal_attr;
  u16 external_attr[2];      // bc padding gets inserted above
  u8 local_header_offset[4]; // unaligned >:(
};

#define CDR_SIZE_BYTES 46
#define CDR_HEADER 0x02014b50

char *parse_central_directory(mapped_jar *jar, u64 cd_offset, u64 cd_size, u32 expected) {
  if (expected > TRACEJVM_MAX_JAR_ENTRIES) {
    return strdup("too many entries in JAR");
  }
  if (cd_offset > jar->size_bytes || cd_size > jar->size_bytes - cd_offset) {
    return strdup("central directory out of bounds");
  }
  const u64 cd_end = cd_offset + cd_size;
  u64 expanded_bytes = 0;
  hash_table_reserve(&jar->entries, expected); // helps performance a lot as we know the exact table size
  struct central_directory_record cdr = {0};
  char error[256];
  for (u32 i = 0; i < expected; i++) {
    if (cd_offset > cd_end || CDR_SIZE_BYTES > cd_end - cd_offset) {
      snprintf(error, sizeof(error), "cdr %d out of bounds", i);
      return strdup(error);
    }
    memcpy(&cdr, jar->data + cd_offset, CDR_SIZE_BYTES);
    if (cdr.header != CDR_HEADER)
      return strdup("missing cdr header bytes");
    const u64 record_size =
        (u64)CDR_SIZE_BYTES + cdr.filename_len + cdr.extra_len + cdr.comment_len;
    if (record_size > cd_end - cd_offset) {
      snprintf(error, sizeof(error), "cdr %d variable data out of bounds", i);
      return strdup(error);
    }
    if (cdr.filename_len == 0) {
      snprintf(error, sizeof(error), "cdr %d has an empty filename", i);
      return strdup(error);
    }
    if (cdr.flags & 1) {
      snprintf(error, sizeof(error), "cdr %d is encrypted", i);
      return strdup(error);
    }
    if (cdr.uncompressed_size > TRACEJVM_MAX_JAR_ENTRY_BYTES) {
      snprintf(error, sizeof(error), "cdr %d exceeds the expanded entry limit", i);
      return strdup(error);
    }
    expanded_bytes += cdr.uncompressed_size;
    if (expanded_bytes > TRACEJVM_MAX_JAR_EXPANDED_BYTES) {
      return strdup("JAR exceeds the total expanded size limit");
    }
    slice filename = {.chars = jar->data + cd_offset + CDR_SIZE_BYTES, .len = cdr.filename_len};
    u32 header_offset;
    memcpy(&header_offset, cdr.local_header_offset, sizeof(header_offset));
    // https://en.wikipedia.org/wiki/ZIP_(file_format)#Local_file_header
    if (header_offset > jar->size_bytes || 30u > jar->size_bytes - header_offset) {
      snprintf(error, sizeof(error), "cdr %d local header out of bounds", i);
      return strdup(error);
    }
    char *local_header = jar->data + header_offset;
    if (memcmp(local_header, "PK\003\004", 4) != 0) {
      snprintf(error, sizeof(error), "cdr %d local header signature mismatch", i);
      return strdup(error);
    }
    u16 local_flags, local_compression, local_filename_len, local_extra_len;
    memcpy(&local_flags, local_header + 6, sizeof(local_flags));
    memcpy(&local_compression, local_header + 8, sizeof(local_compression));
    memcpy(&local_filename_len, local_header + 26, sizeof(local_filename_len));
    memcpy(&local_extra_len, local_header + 28, sizeof(local_extra_len));
    if (local_flags != cdr.flags || local_compression != cdr.compression) {
      snprintf(error, sizeof(error), "cdr %d disagrees with its local header", i);
      return strdup(error);
    }
    const u64 data_offset = (u64)header_offset + 30u + local_filename_len + local_extra_len;
    if (data_offset > jar->size_bytes || cdr.compressed_size > jar->size_bytes - data_offset) {
      snprintf(error, sizeof(error), "cdr %d data out of bounds", i);
      return strdup(error);
    }
    if (cdr.compression != 0 && cdr.compression != 8) {
      snprintf(error, sizeof(error), "cdr %d has unsupported compression type %d (supported: 0, 8)", i,
               cdr.compression);
      return strdup(error);
    }
    if (cdr.compression == 0 && cdr.compressed_size != cdr.uncompressed_size) {
      snprintf(error, sizeof(error), "cdr %d stored size mismatch", i);
      return strdup(error);
    }
    bool is_compressed = cdr.compression != 0;
    cd_offset += record_size;

    jar_entry *ent = malloc(sizeof(jar_entry));
    if (!ent)
      return strdup("out of memory indexing JAR");
    ent->data = jar->data + data_offset;
    ent->compressed_size = cdr.compressed_size;
    ent->claimed_uncompressed_size = cdr.uncompressed_size;
    ent->is_compressed = is_compressed;

    void *old = hash_table_insert(&jar->entries, filename.chars, filename.len, ent);
    if (old) {
      free(old);
      snprintf(error, sizeof(error), "duplicate filename in JAR: %.*s", fmt_slice(filename));
      return strdup(error);
    }
  }
  if (cd_offset != cd_end) {
    return strdup("central directory size mismatch");
  }
  return nullptr;
}

static void free_jar(mapped_jar *jar) {
  free_hash_table(jar->entries);
  if (!jar->is_mmap) {
    if (jar->needs_free)
      free(jar->data);
    jar->data = nullptr;
  } else {
#ifdef USE_MMAP
    munmap(jar->data, jar->size_bytes);
    jar->is_mmap = false;
#else
    UNREACHABLE("mmap not enabled");
#endif
  }
  free(jar);
}

// Attempt to instantiate the contents of mapped_jar by reading it as a ZIP file.
static char *load_filesystem_jar(const char *filename, mapped_jar *jar) {
  char *error;
  bool error_needs_free = false; // whether the error is heap allocated
  char *map_err = map_jar(filename, jar);
  if (map_err) {
    return map_err;
  }
  // Search 22 bytes from the end for the ZIP "end of central directory record" signature
  const char sig[4] = "PK\005\006";
  if (jar->size_bytes < 22 || memcmp(jar->data + jar->size_bytes - 22, sig, 4) != 0) {
    error = "Missing end of central directory record";
    goto inval;
  }

  struct end_of_central_directory_record eocdr = {0};
  static_assert(sizeof(eocdr) >= 22);
  memcpy(&eocdr, (void *)(jar->data + jar->size_bytes - 22), 22);

  if (eocdr.disk_number != 0 || eocdr.disk_with_cd != 0 || eocdr.num_entries != eocdr.total_entries) {
    error = "Multi-disk JARs not supported";
    goto inval;
  }

  const u64 eocdr_offset = jar->size_bytes - 22u;
  if ((u64)eocdr.cd_offset + eocdr.cd_size != eocdr_offset) {
    error = "Central directory does not end at the EOCD record";
    goto inval;
  }

  error = parse_central_directory(jar, eocdr.cd_offset, eocdr.cd_size, eocdr.num_entries);
  error_needs_free = true;
  if (!error) {
    return nullptr; // succeeded
  }

inval:
  char s[256];
  snprintf(s, sizeof(s), "Invalid JAR file %s%s%s", filename, error ? ": " : "", error);
  if (error_needs_free)
    free(error);
  return strdup(s);
}

static char *add_classpath_jar(classpath *cp, slice entry) {
  mapped_jar *jar = calloc(1, sizeof(mapped_jar));
  jar->entries = make_hash_table(free, 0.75, 1);

  char *filename = calloc(1, entry.len + 1);
  memcpy(filename, entry.chars, entry.len);
  char *error = load_filesystem_jar(filename, jar);
  free(filename);

  if (error) {
    printf("JAR loading error: %s\n", error);
    free_jar(jar);
    return error;
  }

  classpath_entry ent = (classpath_entry){.name = make_heap_str_from(entry), .jar = jar};
  arrput(cp->entries, ent);

  return nullptr;
}

static char *add_classpath_entry(classpath *cp, slice entry) {
  // If entry ends in .jar, load it as a JAR, otherwise treat it as a folder
  if (entry.len >= 4 && memcmp(entry.chars + entry.len - 4, ".jar", 4) == 0) {
    return add_classpath_jar(cp, entry);
  }
  classpath_entry ent = (classpath_entry){.name = make_heap_str_from(entry), .jar = nullptr};
  arrput(cp->entries, ent);
  return nullptr;
}

char *init_classpath(classpath *cp, slice path) {
  cp->entries = nullptr;
  cp->as_colon_separated = make_heap_str_from(path);
  int start = 0;
  for (u32 i = 0; i <= path.len; i++) { // iterate over colon separated entries
    if (i == path.len || path.chars[i] == ':') {
      slice entry = subslice_to(path, start, i);
      if (entry.len == 0) // empty entry, ignore (e.g. ::)
        continue;
      char *err = add_classpath_entry(cp, entry);
      if (err) {
        free_classpath(cp); // free everything and return the heap-allocated error
        return err;
      }
      start = i + 1;
    }
  }
  return nullptr;
}

void free_classpath(classpath *cp) {
  for (int i = 0; i < arrlen(cp->entries); i++) {
    free_heap_str(cp->entries[i].name);
    if (cp->entries[i].jar) {
      free_jar(cp->entries[i].jar);
    }
  }
  arrfree(cp->entries);
  free_heap_str(cp->as_colon_separated);
  memset(cp, 0, sizeof(*cp)); // for good measure
}

enum jar_lookup_result { NOT_FOUND, FOUND, CORRUPT /* e.g. if INFLATE fails */ };

// Returns true if found
enum jar_lookup_result jar_lookup(mapped_jar *jar, slice filename, u8 **bytes, size_t *len) {
  jar_entry *jar_entry = hash_table_lookup(&jar->entries, filename.chars, filename.len);
  if (jar_entry) {
    if (!jar_entry->is_compressed) {
      *len = jar_entry->claimed_uncompressed_size;
      *bytes = malloc(*len == 0 ? 1 : *len);
      if (!*bytes)
        return CORRUPT;
      memcpy(*bytes, jar_entry->data, *len);
      return FOUND;
    }

    // Call into zlib
    *bytes = malloc(jar_entry->claimed_uncompressed_size == 0 ? 1 : jar_entry->claimed_uncompressed_size);
    if (!*bytes)
      return CORRUPT;

    z_stream stream = {0};
    stream.next_in = (unsigned char *)jar_entry->data;
    stream.avail_in = jar_entry->compressed_size;
    stream.next_out = *bytes;
    stream.avail_out = jar_entry->claimed_uncompressed_size == 0 ? 1 : jar_entry->claimed_uncompressed_size;

    if (inflateInit2(&stream, -MAX_WBITS) != Z_OK) {
      free(*bytes);
      *bytes = nullptr;
      return CORRUPT;
    }

    int result = inflate(&stream, Z_FINISH);
    if (result != Z_STREAM_END || stream.total_out != jar_entry->claimed_uncompressed_size ||
        stream.total_in != jar_entry->compressed_size) {
      inflateEnd(&stream);
      free(*bytes);
      *bytes = nullptr;
      return CORRUPT;
    }

    *len = stream.total_out;
    inflateEnd(&stream);
    return FOUND;
  }
  return NOT_FOUND;
}

static heap_string concat_path(heap_string name, slice filename) {
  bool slash = !name.len || name.chars[name.len - 1] != '/';
  heap_string result = make_heap_str(name.len + slash + filename.len);
  [[maybe_unused]] slice slice =
      bprintf(hslc(result), "%.*s%s%.*s", fmt_slice(name), slash ? "/" : "", fmt_slice(filename));
  DCHECK(slice.len == result.len);
  return result;
}

static bool bad_filename(const slice filename) {
  for (u32 i = 0; i < filename.len - 1; ++i) {
    if (filename.chars[i] == '.' && filename.chars[i + 1] == '.') {
      return true;
    }
  }
  return false;
}

int lookup_classpath(classpath *cp, const slice filename, u8 **bytes, size_t *len) {
  *bytes = nullptr;
  *len = 0;
  if (bad_filename(filename)) {
    return -1;
  }
  for (int i = 0; i < arrlen(cp->entries); i++) {
    classpath_entry *entry = &cp->entries[i];
    if (entry->jar) {
      enum jar_lookup_result result = jar_lookup(entry->jar, filename, bytes, len);
      if (result == NOT_FOUND)
        continue;
      return -(result == CORRUPT);
    }
    // Concatenate with the desired filename (and optionally a / in between)
    heap_string search = concat_path(entry->name, filename);
    DCHECK(search.chars[search.len] == '\0', "Must be null terminated");

    struct loaded_bytes lb;
    FILE *f = fopen(search.chars, "rb");
    free_heap_str(search);
    if (!f)
      continue;
    lb = read_file(f);
    fclose(f);
    *bytes = (u8 *)lb.bytes;
    *len = lb.length;
    return 0;
  }
  return -1;
}
