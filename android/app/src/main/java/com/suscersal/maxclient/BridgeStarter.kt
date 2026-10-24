package com.suscersal.maxclient

import android.content.Context
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL

/**
 * Локальный Python-сервер (bridge.py) без UI. Нужен, когда процесс разбужен не
 * MainActivity, а, например, ответом из уведомления (ReplyReceiver): раньше сервер
 * в этом случае не был запущен, и ответ терялся.
 */
object BridgeStarter {
    private const val PORT = 8080
    private val lock = Any()

    fun isUp(): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", PORT), 300) }
        true
    } catch (_: Exception) {
        false
    }

    /** Блокирующий вызов (из фонового потока): поднимает сервер, если его ещё нет, и ждёт порт до ~15 с. */
    fun ensureStarted(context: Context): Boolean {
        if (isUp()) return true
        val app = context.applicationContext
        synchronized(lock) {
            if (!MainActivity.serverStartedInProcess) {
                // Тот же флаг, что у MainActivity: она не запустит второй сервер на занятом порту,
                // а при скачанном обновлении перезапустит процесс (см. onFinished в MainActivity).
                MainActivity.serverStartedInProcess = true
                if (!Python.isStarted()) {
                    Python.start(AndroidPlatform(app))
                }
                val hotpatch = OtaUpdater.hotpatchDir(app)
                val hotpatchPath = if (hotpatch.isDirectory) hotpatch.absolutePath else ""
                val sessionFile = File(app.filesDir, "session.json").absolutePath
                Thread {
                    try {
                        Python.getInstance().getModule("bridge_launcher")
                            .callAttr("start_server", sessionFile, PORT, hotpatchPath, app)
                    } catch (_: Exception) {
                    }
                }.start()
            }
        }
        repeat(75) {
            if (isUp()) return true
            Thread.sleep(200)
        }
        return false
    }

    /** Одна попытка: POST /api/notif-reply. true — MAX принял сообщение. */
    fun postReply(chatId: Long, text: String): Boolean {
        return try {
            val conn = URL("http://127.0.0.1:$PORT/api/notif-reply").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 3000
            conn.readTimeout = 25000
            val body = JSONObject().put("chatId", chatId).put("text", text).toString()
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            val code = conn.responseCode
            conn.disconnect()
            code == 200
        } catch (_: Exception) {
            false
        }
    }
}
