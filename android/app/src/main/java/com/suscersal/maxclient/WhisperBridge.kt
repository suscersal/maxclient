package com.suscersal.maxclient

// Тонкая синхронная обёртка над собственной JNI-сборкой upstream
// whisper.cpp (см. app/src/main/cpp) — замена платной
// dev.ffmpegkit-maintained:whisper-android. В отличие от неё работает с
// ЛЮБЫМИ ggml-моделями, включая квантованные (q4_0/q5_1/q8_0) — эти веса
// в разы легче полноточных при небольшой потере качества.
//
// Модель грузится лениво и держится в памяти между вызовами (аналогично
// _get_vosk_model в bridge.py и как было в предыдущей версии этого файла) —
// whisper_init_from_file_with_params не бесплатна: это чтение сотен МБ
// весов с диска и их распаковка в память.
object WhisperBridge {

    init {
        System.loadLibrary("whisper_jni")
    }

    // === JNI (реализация в app/src/main/cpp/whisper_jni.cpp) ===
    @JvmStatic
    private external fun nativeInitContext(modelPath: String): Long

    @JvmStatic
    private external fun nativeFreeContext(ctxPtr: Long)

    @JvmStatic
    private external fun nativeTranscribe(
        ctxPtr: Long, pcm16: ByteArray, language: String, timeoutMs: Long
    ): String

    @JvmStatic
    private external fun nativeGetSystemInfo(): String

    @Volatile
    private var ctxPtr: Long = 0

    @Volatile
    private var loadedModelPath: String? = null

    private val lock = Any()

    // Вызывается из Python: WhisperBridge.transcribe(modelPath, pcm16Bytes, language, timeoutMs)
    // pcm16 — сырые PCM16LE mono сэмплы на 16kHz (bridge.py собирает их из
    // _decode_audio_to_pcm16 и передаёт как jarray(jbyte), тот же формат,
    // что уходит и в Vosk). language — код языка ("ru", "en", ...) или
    // "auto" для автоопределения. timeoutMs — жёсткий лимит на сам
    // whisper_full() внутри JNI (через abort_callback, см.
    // whisper_jni.cpp) — 0 или отрицательное значение означает "без
    // лимита". Это единственный способ реально прервать зависшее
    // распознавание: таймаут на стороне Python бессилен, пока этот вызов
    // удерживает GIL.
    @JvmStatic
    fun transcribe(modelPath: String, pcm16: ByteArray, language: String, timeoutMs: Long = 0L): String {
        val ctx = getOrLoadContext(modelPath)
        if (ctx == 0L) return ""
        return nativeTranscribe(ctx, pcm16, language.ifBlank { "auto" }, timeoutMs).trim()
    }

    // Отдельный публичный метод, вызывается из Python ДО transcribe(), только
    // ради диагностики: чтобы разделить два разных по природе шага, которые
    // раньше были слиты в один HTTP-невидимый вызов transcribe() — (1)
    // nativeInitContext (чтение модели с диска, без таймаута) и (2)
    // nativeTranscribe/whisper_full (с abort_callback-таймаутом). Если
    // зависание было в первом — modelIsReady() до и после вызова покажет
    // разницу, а сам факт возврата из loadModel() уже будет означать, что
    // модель успешно загрузилась и завершение visible на HTTP-стороне.
    @JvmStatic
    fun loadModel(modelPath: String): Boolean {
        return getOrLoadContext(modelPath) != 0L
    }

    @JvmStatic
    fun isModelLoaded(modelPath: String): Boolean = synchronized(lock) {
        ctxPtr != 0L && loadedModelPath == modelPath
    }

    private fun getOrLoadContext(modelPath: String): Long = synchronized(lock) {
        if (ctxPtr != 0L && loadedModelPath == modelPath) {
            return ctxPtr
        }
        // Путь к модели сменился (или это первый вызов) — старый контекст
        // выгружаем перед загрузкой нового.
        if (ctxPtr != 0L) {
            nativeFreeContext(ctxPtr)
            ctxPtr = 0
            loadedModelPath = null
        }
        // nativeInitContext (загрузка ~190МБ весов в память) сама по себе
        // таймаута не имеет — только whisper_full() дальше. На медленном
        // диске/при нехватке памяти зависание может быть уже тут, ещё до
        // начала распознавания. android.util.Log виден через logcat/adb —
        // если под рукой их нет, ориентир хотя бы по времени между этим
        // сообщением и следующим вызовом в логах.
        val t0 = System.currentTimeMillis()
        android.util.Log.d("WhisperBridge", "nativeInitContext start: $modelPath")
        val fresh = nativeInitContext(modelPath)
        android.util.Log.d(
            "WhisperBridge",
            "nativeInitContext done in ${System.currentTimeMillis() - t0}ms, ctx=$fresh"
        )
        if (fresh != 0L) {
            ctxPtr = fresh
            loadedModelPath = modelPath
        }
        return fresh
    }

    // Вызывается из Python при удалении/замене модели (см.
    // delete_whisper_model / _install_whisper_model_from_file в bridge.py),
    // чтобы освободить память сразу и не работать со старыми весами после
    // подмены файла на диске по тому же пути.
    @JvmStatic
    fun releaseModel() = synchronized(lock) {
        if (ctxPtr != 0L) {
            nativeFreeContext(ctxPtr)
            ctxPtr = 0
            loadedModelPath = null
        }
    }

    @JvmStatic
    fun getSystemInfo(): String = nativeGetSystemInfo()
}