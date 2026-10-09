package com.suscersal.maxclient

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Настоящий фоновый push через FCM (формат подтверждён Komet:
 * backend/modules/account/privacy_module.dart registerPushToken — сервер
 * ждёт opcode 22 "config" с {pushToken, pushOptions: 0}).
 *
 * Как это работает: токен отправляется локальному bridge.py (127.0.0.1,
 * тот же процесс/сервер, что обслуживает WebView), а уже bridge.py
 * регистрирует его на сервере MAX при следующем успешном логине. Дальше
 * push шлёт САМ сервер MAX через свой Firebase-проект — этот сервис нужен
 * только чтобы (1) отдать токен один раз при его получении/обновлении и
 * (2) на случай, если MAX пришлёт data-only сообщение без готового
 * notification-блока — тогда Android сам ничего не покажет, и это нужно
 * сделать руками (см. onMessageReceived). Если MAX всегда шлёт обычный
 * notification-пуш (как похоже на то, что видно в Komet — там тоже нет
 * кастомного кода показа уведомления), этот путь может вообще не
 * понадобиться, но оставляю как подстраховку.
 */
/** Общая логика отправки FCM-токена локальному bridge.py — нужна и
 * FcmService (onNewToken), и MainActivity (проактивный запрос при старте,
 * на случай когда токен не менялся и onNewToken не вызовется повторно). */
object FcmTokenSender {
    private const val LOCAL_PORT = 8080 // как в MainActivity: val port = 8080

    /** Синхронный HTTP-запрос — всегда вызывать из фонового потока. */
    fun sendBlocking(token: String) {
        try {
            val url = URL("http://127.0.0.1:$LOCAL_PORT/api/push/register-fcm-token")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val body = JSONObject().put("token", token).toString()
            OutputStreamWriter(conn.outputStream).use { it.write(body) }
            conn.responseCode // форсируем выполнение запроса
            conn.disconnect()
        } catch (_: Exception) {
            // bridge.py может быть ещё не запущен — не страшно, при
            // следующем успешном старте/обновлении токена попробуем снова.
        }
    }
}

/** Сообщает локальному bridge.py, пользуются ли сейчас приложением. bridge.py
 * в ответ шлёт серверу MAX ping {interactive: bool} (опкод 1) — тогда в
 * фоне сессия перестаёт считаться "онлайн", и сервер, предположительно,
 * начинает слать настоящие push (см. комментарий в bridge.py у
 * /api/session/interactive). Делается из нативного кода, а не из JS:
 * на паузе WebView скрипты могут не выполниться, а Python-поток живёт. */
object InteractiveSender {
    private const val LOCAL_PORT = 8080 // как в MainActivity: val port = 8080

    fun send(interactive: Boolean) {
        Thread {
            try {
                val url = URL("http://127.0.0.1:$LOCAL_PORT/api/session/interactive")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                val body = JSONObject().put("interactive", interactive).toString()
                OutputStreamWriter(conn.outputStream).use { it.write(body) }
                conn.responseCode
                conn.disconnect()
            } catch (_: Exception) {
                // bridge.py ещё не поднят или уже остановлен — не критично
            }
        }.start()
    }
}

class FcmService : FirebaseMessagingService() {

    companion object {
        private const val NOTIF_CHANNEL_ID = "max_client_messages"
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Thread { FcmTokenSender.sendBlocking(token) }.start()
    }

    override fun onMessageReceived(message: RemoteMessage) {
        super.onMessageReceived(message)
        // Если в пуше уже есть notification-блок — Android показал его
        // автоматически ДО вызова этого метода, второй раз показывать не
        // нужно (иначе будет дублирующееся уведомление).
        if (message.notification != null) return

        val data = message.data
        val title = data["title"] ?: "MAX"
        val body = data["body"] ?: data["text"] ?: return // нечего показывать
        showFallbackNotification(title, body)
    }

    private fun showFallbackNotification(title: String, body: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(NOTIF_CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        NOTIF_CHANNEL_ID,
                        "Сообщения MAX Client",
                        NotificationManager.IMPORTANCE_HIGH
                    )
                )
            }
        }
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(System.currentTimeMillis().toInt(), notification)
    }
}
