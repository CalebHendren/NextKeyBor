cmake_minimum_required(VERSION 3.24)
project(NextKeyBor VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(NKB_SYSTEM_WHISPER "Use a system-installed whisper.cpp (find_package(whisper))" OFF)
option(NKB_WHISPER_VULKAN "Build bundled whisper.cpp with the Vulkan backend" OFF)

include(GNUInstallDirs)
include(FetchContent)
find_package(PkgConfig REQUIRED)
pkg_check_modules(GIO REQUIRED IMPORTED_TARGET gio-2.0 gio-unix-2.0 glib-2.0)
find_package(CURL 7.85 REQUIRED)  # CURLOPT_PROTOCOLS_STR
find_package(Threads REQUIRED)

FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(json)

if(NKB_SYSTEM_WHISPER)
  find_package(whisper REQUIRED)
else()
  set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
  set(GGML_VULKAN ${NKB_WHISPER_VULKAN} CACHE BOOL "" FORCE)
  FetchContent_Declare(whisper
    GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
    GIT_TAG v1.9.4
    GIT_SHALLOW TRUE
    SYSTEM)
  FetchContent_MakeAvailable(whisper)
endif()

add_subdirectory(daemon)
