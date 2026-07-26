package com.example.maxclient

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Обновление "горячих" файлов (bridge.py, msgpack_lite.py, index.html,
 * avatars.json, manifest.json, loading.gif, assets/... ) без пересборки и
 * переустановки APK.
 *
 * Логика:
 *  1. Скачиваем ota/version.json из последнего GitHub Release репозитория
 *     (его туда кладёт CI — см. .github/workflows/build-and-relis.yml и
 *     scripts/generate-ota-manifest.sh).
 *  2. Сравниваем версию с сохранённой локально (SharedPreferences).
 *  3. Если версия новее — качаем изменившиеся файлы (по sha256) в
 *     filesDir/hotpatch и сохраняем новую версию.
 *
 * ВАЖНО: OWNER/REPO ниже — заглушка, впиши сюда свои значения
 * (например "ivanov" / "max-client").
 */
object OtaUpdater {

    private const val OWNER = "OWNER"   // TODO: заменить на владельца репозитория
    private const val REPO = "REPO"     // TODO: заменить на имя репозитория
    private const val PREFS = "ota_prefs"
    private const val KEY_VERSION = "hot_version"

    private val RELEASES_LATEST_URL =
        "https://api.github.com/repos/$OWNER/$REPO/releases/latest"

    interface ProgressListener {
        /** percent от 0 до 100, statusText — что показать пользователю */
        fun onProgress(percent: Int, statusText: String)
        fun onFinished(hotpatchDir: File?)
    }

    fun hotpatchDir(ctx: Context): File = File(ctx.filesDir, "hotpatch")

    /**
     * Вызывать из фонового потока (не UI thread) — делает сетевые запросы.
     * Колбэки listener'а вызывающая сторона сама переводит на UI-поток при
     * необходимости (см. MainActivity).
     */
    fun checkAndUpdate(ctx: Context, listener: ProgressListener) {
        try {
            listener.onProgress(0, "Проверка обновлений…")

            val releaseJson = httpGetJson(RELEASES_LATEST_URL)
            val assets = releaseJson.optJSONArray("assets")
            if (assets == null || assets.length() == 0) {
                listener.onFinished(existingHotpatchOrNull(ctx))
                return
            }

            // Ищем среди ассетов релиза version.json
            var versionAssetUrl: String? = null
            val fileAssetUrls = HashMap<String, String>() // имя файла -> browser_download_url
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                val name = a.getString("name")
                val url = a.getString("browser_download_url")
                if (name == "version.json") {
                    versionAssetUrl = url
                } else {
                    fileAssetUrls[name] = url
                }
            }

            if (versionAssetUrl == null) {
                // В этом релизе нет OTA-пакета (например, самый первый релиз
                // до внедрения этого механизма) — просто продолжаем со
                // старой версией, если она уже скачана раньше.
                listener.onFinished(existingHotpatchOrNull(ctx))
                return
            }

            val remoteManifest = httpGetJson(versionAssetUrl)
            val remoteVersion = remoteManifest.getString("version")
            val remoteFiles = remoteManifest.getJSONObject("files")

            val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val localVersion = prefs.getString(KEY_VERSION, null)

            val dir = hotpatchDir(ctx)

            // Даже если версия совпадает, но папки ещё нет (первый запуск
            // после установки) — качаем всё равно.
            if (localVersion == remoteVersion && dir.exists()) {
                listener.onFinished(dir)
                return
            }

            dir.mkdirs()

            val names = remoteFiles.keys().asSequence().toList()
            var done = 0
            for (name in names) {
                val expectedHash = remoteFiles.getString(name)
                val destFile = File(dir, name)

                // Пропускаем файл, если он уже скачан и хэш совпадает —
                // это ускоряет докачку, когда изменилась только часть файлов.
                if (destFile.exists() && sha256(destFile) == expectedHash) {
                    done++
                    listener.onProgress(
                        (done * 100 / names.size),
                        "Обновление… ($done/${names.size})"
                    )
                    continue
                }

                val downloadUrl = fileAssetUrls[name]
                if (downloadUrl != null) {
                    destFile.parentFile?.mkdirs()
                    downloadToFile(downloadUrl, destFile)
                }

                done++
                listener.onProgress(
                    (done * 100 / names.size),
                    "Обновление… ($done/${names.size})"
                )
            }

            prefs.edit().putString(KEY_VERSION, remoteVersion).apply()
            listener.onFinished(dir)
        } catch (e: Exception) {
            // Нет сети / GitHub недоступен / репозиторий приватный и т.п. —
            // не блокируем запуск приложения, просто работаем на том, что
            // уже было скачано раньше (или на версии из APK, если ничего
            // ещё не скачивалось).
            listener.onFinished(existingHotpatchOrNull(ctx))
        }
    }

    private fun existingHotpatchOrNull(ctx: Context): File? {
        val dir = hotpatchDir(ctx)
        return if (dir.exists() && dir.listFiles()?.isNotEmpty() == true) dir else null
    }

    private fun httpGetJson(urlStr: String): JSONObject {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        conn.setRequestProperty("Accept", "application/vnd.github+json")
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.inputStream.use { input ->
            val text = input.bufferedReader().readText()
            return JSONObject(text)
        }
    }

    private fun downloadToFile(urlStr: String, dest: File) {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 15000
        conn.instanceFollowRedirects = true
        conn.inputStream.use { input ->
            dest.outputStream().use { output ->
                input.copyTo(output)
            }
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(8192)
            var n: Int
            while (input.read(buf).also { n = it } >= 0) {
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}