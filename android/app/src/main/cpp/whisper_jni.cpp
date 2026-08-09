// JNI-мост между WhisperBridge.kt и upstream whisper.cpp (MIT).
// Три пары: init/free контекста + сама транскрипция, плюс диагностика
// сборки (nativeGetSystemInfo) — пригодится в _java_import_diagnostics.

#include <jni.h>
#include <string>
#include <vector>
#include <cstring>
#include <chrono>
#include "whisper.h"

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_suscersal_maxclient_WhisperBridge_nativeInitContext(
        JNIEnv *env, jclass /*clazz*/, jstring modelPath) {
    const char *path = env->GetStringUTFChars(modelPath, nullptr);

    struct whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = false; // CPU-only на мобильных — без OpenCL/Metal-бэкенда

    struct whisper_context *ctx = whisper_init_from_file_with_params(path, cparams);

    env->ReleaseStringUTFChars(modelPath, path);

    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL
Java_com_suscersal_maxclient_WhisperBridge_nativeFreeContext(
        JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr) {
    if (ctxPtr == 0) return;
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);
    whisper_free(ctx);
}

// Контекст для abort_callback ниже — единственный надёжный способ прервать
// уже идущий whisper_full(): таймаут на стороне Python (через
// concurrent.futures/threading) бессилен, пока этот вызов удерживает GIL
// внутри JNI-звонка (см. обсуждение в bridge.py у ONDEVICE_TIMEOUT) — сам
// поток, который должен был бы засечь таймаут, не может выполниться, пока
// GIL не освобождён, а он не освобождается, пока мы тут в native-коде.
// abort_callback же дергается самим whisper.cpp периодически ИЗНУТРИ
// вычисления (между шагами энкодера/декодера), поэтому реально может его
// остановить.
struct AbortCtx {
    std::chrono::steady_clock::time_point deadline;
    bool hasDeadline;
    bool aborted;
};

static bool whisper_abort_check(void *user_data) {
    auto *ctx = static_cast<AbortCtx *>(user_data);
    if (!ctx->hasDeadline) return false;
    if (std::chrono::steady_clock::now() >= ctx->deadline) {
        ctx->aborted = true;
        return true;
    }
    return false;
}

JNIEXPORT jstring JNICALL
Java_com_suscersal_maxclient_WhisperBridge_nativeTranscribe(
        JNIEnv *env, jclass /*clazz*/, jlong ctxPtr,
        jbyteArray pcm16, jstring language, jlong timeoutMs) {
    if (ctxPtr == 0) {
        return env->NewStringUTF("");
    }
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);

    // PCM16LE mono -> float32 [-1, 1], как ожидает whisper_full
    jsize byteLen = env->GetArrayLength(pcm16);
    jbyte *bytes = env->GetByteArrayElements(pcm16, nullptr);

    size_t sampleCount = static_cast<size_t>(byteLen) / 2;
    std::vector<float> samples(sampleCount);
    const auto *pcm = reinterpret_cast<const int16_t *>(bytes);
    for (size_t i = 0; i < sampleCount; ++i) {
        samples[i] = static_cast<float>(pcm[i]) / 32768.0f;
    }
    env->ReleaseByteArrayElements(pcm16, bytes, JNI_ABORT);

    const char *langChars = env->GetStringUTFChars(language, nullptr);
    std::string lang(langChars);
    env->ReleaseStringUTFChars(language, langChars);

    AbortCtx abortCtx{};
    abortCtx.hasDeadline = timeoutMs > 0;
    abortCtx.aborted = false;
    if (abortCtx.hasDeadline) {
        abortCtx.deadline = std::chrono::steady_clock::now() +
                             std::chrono::milliseconds(timeoutMs);
    }

    struct whisper_full_params wparams =
            whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wparams.print_progress = false;
    wparams.print_special = false;
    wparams.print_realtime = false;
    wparams.print_timestamps = false;
    wparams.translate = false;
    wparams.single_segment = false;
    wparams.no_context = true;
    wparams.language = (lang == "auto") ? nullptr : lang.c_str();
    wparams.n_threads = 4;
    wparams.abort_callback = whisper_abort_check;
    wparams.abort_callback_user_data = &abortCtx;

    int rc = whisper_full(ctx, wparams, samples.data(), static_cast<int>(samples.size()));

    if (abortCtx.aborted) {
        // Бросаем исключение до Java/Kotlin — тот же паттерн, что и у
        // остальных ошибок on-device распознавания в bridge.py
        // (_run_transcribe_ondevice_whisper их сама ловит и решает про
        // fallback). Chaquopy на Python-стороне превратит это в обычное
        // Python-исключение.
        jclass excCls = env->FindClass("java/lang/RuntimeException");
        if (excCls != nullptr) {
            env->ThrowNew(excCls, "whisper_full прерван по таймауту (abort_callback)");
        }
        return env->NewStringUTF("");
    }

    if (rc != 0) {
        return env->NewStringUTF("");
    }

    std::string result;
    int nSegments = whisper_full_n_segments(ctx);
    for (int i = 0; i < nSegments; ++i) {
        const char *segText = whisper_full_get_segment_text(ctx, i);
        result += segText;
    }

    return env->NewStringUTF(result.c_str());
}

JNIEXPORT jstring JNICALL
Java_com_suscersal_maxclient_WhisperBridge_nativeGetSystemInfo(
        JNIEnv *env, jclass /*clazz*/) {
    const char *info = whisper_print_system_info();
    return env->NewStringUTF(info ? info : "");
}

} // extern "C"