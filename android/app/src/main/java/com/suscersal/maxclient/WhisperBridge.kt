package com.suscersal.maxclient

import android.content.Context
import dev.ffmpegkit.whisper.Whisper
import dev.ffmpegkit.whisper.WhisperConfig
import dev.ffmpegkit.whisper.WhisperModel
import kotlinx.coroutines.runBlocking

// Тонкая синхронная обёртка над whisper-android (free-tier AAR, только
// файловая транскрипция на arm64-v8a — см. build.gradle). Whisper.* — это
// suspend-функции корутин; Chaquopy же зовёт Kotlin/Java строго синхронно
// (как и с org.vosk.Recognizer в bridge.py), поэтому здесь используется
// runBlocking, а не сам bridge.py, чтобы не тащить kotlinx.coroutines в
// Python-слой.
//
// Модель грузится лениво и держится в памяти между вызовами (аналогично
// _get_vosk_model в bridge.py) — WhisperModel.loadModel не бесплатна:
// это чтение ~466 МБ весов ggml-small.bin с диска.
object WhisperBridge {

    @Volatile
    private var loadedModel: WhisperModel? = null

    @Volatile
    private var loadedModelPath: String? = null

    private val lock = Any()

    // Вызывается из Python: WhisperBridge.transcribe(context, modelPath, audioPath, language)
    // audioPath — WAV/MP3/FLAC (whisper.cpp сам ресемплирует в 16kHz mono,
    // ffmpeg не нужен). PCM16 из _decode_audio_to_pcm16 в bridge.py нужно
    // сперва завернуть в WAV-контейнер — см. _pcm16_to_wav_bytes на
    // Python-стороне.
    @JvmStatic
    fun transcribe(context: Context, modelPath: String, audioPath: String, language: String): String =
        runBlocking {
            val model = getOrLoadModel(context, modelPath)
            val result = Whisper.transcribe(model, audioPath, WhisperConfig(language = language))
            result.text.trim()
        }

    private fun getOrLoadModel(context: Context, modelPath: String): WhisperModel = synchronized(lock) {
        val current = loadedModel
        if (current != null && loadedModelPath == modelPath) {
            return current
        }
        // Путь к модели сменился (или это первый вызов) — старую выгружаем.
        current?.let { Whisper.releaseModel(it) }
        val fresh = runBlocking { Whisper.loadModel(context, modelPath) }
        loadedModel = fresh
        loadedModelPath = modelPath
        return fresh
    }

    // Вызывается из Python при удалении модели (см. delete_asr_model /
    // аналог для Whisper), чтобы освободить память сразу, а не ждать GC.
    @JvmStatic
    fun releaseModel() = synchronized(lock) {
        loadedModel?.let { Whisper.releaseModel(it) }
        loadedModel = null
        loadedModelPath = null
    }

    @JvmStatic
    fun getSystemInfo(): String = Whisper.getSystemInfo()
}
