cmake_minimum_required(VERSION 3.15)
project(viewcord_audio VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# MinHook (baixe de https://github.com/TsudaKageyu/minhook)
set(MINHOOK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../minhook")

# Adiciona MinHook como biblioteca estática
add_library(minhook STATIC
    ${MINHOOK_DIR}/src/buffer.c
    ${MINHOOK_DIR}/src/hook.c
    ${MINHOOK_DIR}/src/trampoline.c
    ${MINHOOK_DIR}/src/hde/hde32.c
    ${MINHOOK_DIR}/src/hde/hde64.c
)

target_include_directories(minhook PUBLIC ${MINHOOK_DIR}/include)

# DLL principal
add_library(viewcord_audio SHARED
    src/dllmain.cpp
    src/audio_hook.cpp
)

target_link_libraries(viewcord_audio PRIVATE minhook)

# Include dirs do Windows SDK
target_include_directories(viewcord_audio PRIVATE
    ${CMAKE_WINDOWS_KITS_10_DIR}/Include/10.0.22621.0/shared
    ${CMAKE_WINDOWS_KITS_10_DIR}/Include/10.0.22621.0/um
)

# Link libraries
target_link_libraries(viewcord_audio PRIVATE
    ole32
    uuid
)

# Output name
set_target_properties(viewcord_audio PROPERTIES
    OUTPUT_NAME "viewcord_audio"
    PREFIX ""
)
