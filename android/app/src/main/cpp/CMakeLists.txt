cmake_minimum_required(VERSION 3.22.1)
project(whisper_jni)

# whisper.cpp подключается как git submodule (upstream, MIT-лицензия) —
# см. инструкцию в android/app/src/main/cpp/README.md. Сюда НЕ коммитим
# исходники whisper.cpp напрямую, только ссылку на submodule, чтобы не
# тащить чужой репозиторий целиком и не терять обновления апстрима.
set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/whisper.cpp)

if(NOT EXISTS ${WHISPER_DIR}/CMakeLists.txt)
    message(FATAL_ERROR
        "whisper.cpp submodule не найден по пути ${WHISPER_DIR}.\n"
        "Выполните из корня репозитория:\n"
        "  git submodule add https://github.com/ggml-org/whisper.cpp android/app/src/main/cpp/whisper.cpp\n"
        "  git submodule update --init --recursive")
endif()

# Не собираем примеры/тесты/сервер whisper.cpp — только libwhisper и ggml,
# это заметно ускоряет сборку и не тянет лишние зависимости (SDL2 и т.п.)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

# GGML_NATIVE=OFF обязателен для кросс-компиляции под Android NDK — иначе
# сборка попытается использовать флаги CPU хост-машины (сборочного
# сервера), несовместимые с ARM-устройством.
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)

add_subdirectory(${WHISPER_DIR} whisper_build)

add_library(whisper_jni SHARED
    whisper_jni.cpp
)

target_include_directories(whisper_jni PRIVATE
    ${WHISPER_DIR}/include
    ${WHISPER_DIR}/ggml/include
)

target_link_libraries(whisper_jni
    whisper
    android
    log
)
