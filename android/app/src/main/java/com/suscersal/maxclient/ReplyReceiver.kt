package com.suscersal.maxclient

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Ответ из уведомления (кнопка «Ответить», RemoteInput). Текст уходит локальному
 * bridge.py (POST /api/notif-reply), тот отправляет сообщение через MAX (opcode 64).
 * После отправки висящее уведомление обновляется: ответ появляется в переписке
 * и пропадает индикатор отправки.
 */
class ReplyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != FcmService.ACTION_REPLY) return
        val text = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(FcmService.KEY_REPLY)?.toString()?.trim()
        val chatId = intent.getLongExtra(FcmService.EXTRA_CHAT_ID, 0L)
        val notifId = intent.getIntExtra(FcmService.EXTRA_NOTIF_ID, 0)
        if (text.isNullOrEmpty() || chatId == 0L) return

        val pendingResult = goAsync()
        Thread {
            var ok = false
            try {
                ok = send(chatId, text)
            } catch (_: Exception) {
            } finally {
                try {
                    refreshNotification(context, notifId, chatId, text, ok)
                } catch (_: Exception) {
                }
                pendingResult.finish()
            }
        }.start()
    }

    /** bridge.py мог ещё не подняться (процесс разбужен FCM) — пробуем несколько раз. */
    private fun send(chatId: Long, text: String): Boolean {
        repeat(3) { attempt ->
            try {
                val conn = URL("http://127.0.0.1:8080/api/notif-reply").openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.connectTimeout = 3000
                conn.readTimeout = 9000
                val body = JSONObject().put("chatId", chatId).put("text", text).toString()
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
                val code = conn.responseCode
                conn.disconnect()
                if (code == 200) return true
            } catch (_: Exception) {
            }
            if (attempt < 2) Thread.sleep(1000)
        }
        return false
    }

    private fun refreshNotification(context: Context, notifId: Int, chatId: Long, text: String, ok: Boolean) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val existing = manager.activeNotifications.firstOrNull { it.id == notifId }?.notification ?: return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(existing) ?: return
        val now = System.currentTimeMillis()
        style.addMessage(if (ok) text else "⚠ Не отправлено: $text", now, style.user)
        manager.notify(notifId, FcmService.buildNotification(context, notifId, chatId, style, now, true))
    }
}
