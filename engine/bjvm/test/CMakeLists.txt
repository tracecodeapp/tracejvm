set(CMAKE_CXX_STANDARD 26)

include(AddNodeShebang)
include(PostprocessWasm)
include(Doctest)

find_package(OpenMP)

set(TRACEJVM_REQUIRED_TEST_JARS
        jdk23.jar
        test_files/basic_classloader/external.jar
        test_files/broken_jar/this_is_a_jar.jar
        test_files/intact_jar/ok.jar
        test_files/json/gson-2.11.0.jar
        test_files/json/jackson-annotations-2.18.2.jar
        test_files/json/jackson-core-2.18.2.jar
        test_files/json/jackson-databind-2.18.2.jar
        test_files/share/junit-platform-console-standalone-1.12.0.jar
        test_files/share/kotlin-stdlib-2.1.10.jar
        test_files/url-classloader/test.jar)
foreach (fixture IN LISTS TRACEJVM_REQUIRED_TEST_JARS)
    if (NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/${fixture}")
        message(FATAL_ERROR
                "Missing ${fixture}. Run pnpm materialize:test-fixtures with TRACEJVM_JAVA23_HOME set before configuring native tests.")
    endif ()
endforeach ()

add_executable(tests tests.cc tests-main.cc arrays-test.cc tests-common.cc wasm-tests.cc
        async-test.cc
        analysis-tests.cc
        classpath-tests.cc
        natives-test.cc
        benches.cc)
run_emscripten_postprocess(tests)

if (EMSCRIPTEN)
    AddNodeShebang(tests)
endif()

if (NOT EMSCRIPTEN)
    target_link_libraries(tests PRIVATE z)
    target_link_libraries(tests PRIVATE bjvm_static)
else()
    target_link_libraries(tests PRIVATE "-Wl,--whole-archive" bjvm_static)
    target_link_options(tests PRIVATE -sNODERAWFS)  # We're running our tests in Node, so just do this
endif()

target_link_libraries(tests PUBLIC doctest::doctest)

if(OpenMP_CXX_FOUND)
    target_link_libraries(tests PUBLIC OpenMP::OpenMP_CXX)
endif()

if (NOT EMSCRIPTEN)
add_test(NAME tests
        COMMAND tests --skip-benchmarks
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
else()
add_test(NAME tests
        COMMAND nvm use --lts && node ${CMAKE_SOURCE_DIR}/build/test/tests.js --skip-benchmarks
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
endif()

set_tests_properties(tests PROPERTIES ENVIRONMENT "ASAN_OPTIONS=detect_leaks=1,detect_container_overflow=0")
set_tests_properties(tests PROPERTIES ENVIRONMENT "BOOT_CLASSPATH=${CMAKE_CURRENT_SOURCE_DIR}/jdk23.jar")
