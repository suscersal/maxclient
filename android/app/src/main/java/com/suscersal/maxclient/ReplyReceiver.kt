package com.suscersal.maxclient

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput

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
            // Запись на диск ДО отправки: если процесс убьют или сети нет — ответ не пропадёт.
            val id = PendingReplies.add(context, chatId, text)
            try {
                // Процесс мог быть разбужен FCM без MainActivity — тогда Python-сервер ещё не запущен.
                if (BridgeStarter.ensureStarted(context)) {
                    ok = PendingReplies.trySend(context, id, chatId, text)
                    if (!ok) {
                        Thread.sleep(1000)
                        // trySend снимает «в работе»; занимаем снова, чтобы flush не отправил дубль параллельно
                        if (PendingReplies.reserve(id)) {
                            ok = PendingReplies.trySend(context, id, chatId, text)
                        }
                    }
                } else {
                    PendingReplies.release(id)
                }
            } catch (_: Exception) {
                PendingReplies.release(id)
            } finally {
                try {
                    refreshNotification(context, notifId, chatId, text, ok)
                } catch (_: Exception) {
                }
                if (ok) {
                    try {
                        PendingReplies.flush(context)
                    } catch (_: Exception) {
                    }
                }
                pendingResult.finish()
            }
        }.start()
    }

    private fun refreshNotification(context: Context, notifId: Int, chatId: Long, text: String, ok: Boolean) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val existing = manager.activeNotifications.firstOrNull { it.id == notifId }?.notification ?: return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(existing) ?: return
        val now = System.currentTimeMillis()
        style.addMessage(if (ok) text else "⚠ Не отправлено, уйдёт при запуске приложения: $text", now, style.user)
        manager.notify(notifId, FcmService.buildNotification(context, notifId, chatId, style, now, true))
    }
}
