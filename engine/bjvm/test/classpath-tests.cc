#include "doctest/doctest.h"
#include <classpath.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace {
void append_u16(std::vector<u8> &bytes, u16 value) {
  bytes.push_back(value & 0xff);
  bytes.push_back((value >> 8) & 0xff);
}

void append_u32(std::vector<u8> &bytes, u32 value) {
  append_u16(bytes, value & 0xffff);
  append_u16(bytes, value >> 16);
}

std::vector<u8> stored_jar(
    const std::string &name, const std::string &content, u32 claimed_size = 0,
    u16 central_filename_length = 0) {
  const u32 size = claimed_size == 0 ? content.size() : claimed_size;
  std::vector<u8> bytes;
  append_u32(bytes, 0x04034b50);
  append_u16(bytes, 20);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u32(bytes, 0);
  append_u32(bytes, content.size());
  append_u32(bytes, size);
  append_u16(bytes, name.size());
  append_u16(bytes, 0);
  bytes.insert(bytes.end(), name.begin(), name.end());
  bytes.insert(bytes.end(), content.begin(), content.end());

  const u32 central_offset = bytes.size();
  append_u32(bytes, 0x02014b50);
  append_u16(bytes, 20);
  append_u16(bytes, 20);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u32(bytes, 0);
  append_u32(bytes, content.size());
  append_u32(bytes, size);
  append_u16(bytes, central_filename_length == 0 ? name.size() : central_filename_length);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u32(bytes, 0);
  append_u32(bytes, 0);
  bytes.insert(bytes.end(), name.begin(), name.end());
  const u32 central_size = bytes.size() - central_offset;

  append_u32(bytes, 0x06054b50);
  append_u16(bytes, 0);
  append_u16(bytes, 0);
  append_u16(bytes, 1);
  append_u16(bytes, 1);
  append_u32(bytes, central_size);
  append_u32(bytes, central_offset);
  append_u16(bytes, 0);
  return bytes;
}

std::filesystem::path write_jar(const std::vector<u8> &bytes, const std::string &name) {
  const auto path = std::filesystem::temp_directory_path() / name;
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
  output.close();
  return path;
}
} // namespace

TEST_SUITE_BEGIN("[classpath]");

TEST_CASE("Basic classpath operations") {
  classpath cp;
  char *error = init_classpath(&cp, STR("test_files/broken_jar1/this_is_a_jar.jar"));
  REQUIRE(error != nullptr);
  free(error);
  free_classpath(&cp);

  char *error2 = init_classpath(&cp, STR("test_files/intact_jar/ok.jar"));
  REQUIRE(error2 == nullptr);
  u8 *bytes;
  size_t len;
  int ret_val = lookup_classpath(&cp, STR("Egg.class"), &bytes, &len);
  REQUIRE(bytes != nullptr);
  REQUIRE(ret_val == 0);
  free(bytes);
  ret_val = lookup_classpath(&cp, STR("Chicken.class"), &bytes, &len);
  REQUIRE(bytes != nullptr);
  REQUIRE(ret_val == 0);
  free(bytes);
  ret_val = lookup_classpath(&cp, STR("Dog.class"), &bytes, &len);
  REQUIRE(bytes == nullptr);
  REQUIRE(ret_val == -1);
  free_classpath(&cp);
}

TEST_CASE("Folder in classpath") {
  classpath cp;
  char *error = init_classpath(&cp, STR("./jdk23.jar:test_files/circularity:test_files/classpath_test"));
  REQUIRE(error == nullptr);

  u8 *bytes;
  size_t len;
  int ret_val = lookup_classpath(&cp, STR("jdk/internal/misc/Unsafe.class"), &bytes, &len);
  REQUIRE(bytes != nullptr);
  REQUIRE(ret_val == 0);
  free(bytes);
  ret_val = lookup_classpath(&cp, STR("Chick.class"), &bytes, &len);
  REQUIRE(bytes != nullptr);
  REQUIRE(ret_val == 0);
  free(bytes);
  ret_val = lookup_classpath(&cp, STR("nested/boi/Boi.class"), &bytes, &len);
  REQUIRE(bytes != nullptr);
  REQUIRE(ret_val == 0);
  free(bytes);
  ret_val = lookup_classpath(&cp, STR("../classpath_test/Chick.class"), &bytes, &len);
  REQUIRE(bytes == nullptr);
  REQUIRE(ret_val == -1);
  free(bytes);

  free_classpath(&cp);
}

TEST_CASE("JAR parser rejects central-directory and stored-size corruption") {
  for (const auto &[bytes, name] : std::vector<std::pair<std::vector<u8>, std::string>>{
           {stored_jar("Main.class", "valid", 0, 0xffff), "tracejvm-cdr-bounds.jar"},
           {stored_jar("Main.class", "short", 4096), "tracejvm-stored-size.jar"},
           {stored_jar("Main.class", "short", UINT32_MAX), "tracejvm-expanded-size.jar"},
       }) {
    const auto path = write_jar(bytes, name);
    classpath cp;
    const std::string path_string = path.string();
    char *error = init_classpath(&cp, (slice){.chars = const_cast<char *>(path_string.data()), .len = (u32)path_string.size()});
    REQUIRE(error != nullptr);
    free(error);
    free_classpath(&cp);
    std::filesystem::remove(path);
  }
}

TEST_CASE("JAR parser preserves valid stored entries") {
  const auto path = write_jar(stored_jar("Main.class", "valid"), "tracejvm-valid-stored.jar");
  const std::string path_string = path.string();
  classpath cp;
  char *error = init_classpath(&cp, (slice){.chars = const_cast<char *>(path_string.data()), .len = (u32)path_string.size()});
  REQUIRE(error == nullptr);
  u8 *bytes = nullptr;
  size_t length = 0;
  REQUIRE(lookup_classpath(&cp, STR("Main.class"), &bytes, &length) == 0);
  REQUIRE(length == 5);
  REQUIRE(std::string(reinterpret_cast<char *>(bytes), length) == "valid");
  free(bytes);
  free_classpath(&cp);
  std::filesystem::remove(path);
}

TEST_SUITE_END;
