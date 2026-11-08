package com.suscersal.maxclient

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.ContextCompat

/**
 * Мост JS -> установка нового APK прямо из окна «Вышла новая версия» (mx-ui.js).
 * Скачивает системным DownloadManager (прогресс виден в шторке), после загрузки открывает установщик.
 * Принимаются только ссылки на ассеты релизов этого репозитория.
 */
class AndroidApkInstallerBridge(private val activity: Activity, private val toMain: (String) -> Unit) {

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun install(url: String?, name: String?) {
        if (url.isNullOrEmpty()) return
        activity.runOnUiThread { ApkUpdater.start(activity, url, name ?: "maxclient-update.apk", toMain) }
    }

    /** Отменить текущую загрузку (кнопка «Отмена» в окне прогресса). */
    @JavascriptInterface
    fun cancel() {
        activity.runOnUiThread { ApkUpdater.cancel(activity) }
    }
}

object ApkUpdater {
    @Volatile
    private var downloadId: Long = -1L
    private var registered = false
    private val ui = Handler(Looper.getMainLooper())
    private var polling = false
    private var report: (String) -> Unit = {}

    // состояния для mx-ui.js: run / pause / ok / fail / cancel / perm; done и total — байты (total = -1, пока размер неизвестен)
    private fun emit(state: String, done: Long, total: Long, reason: Int = 0) {
        report("window.__mxApkProgress&&window.__mxApkProgress({s:\"" + state + "\",done:" + done + ",total:" + total + ",reason:" + reason + "})")
    }

    // раз в 0,5 с спрашиваем у DownloadManager, сколько скачано; остановка — на ok / fail / cancel
    private fun poll(app: Context) {
        if (polling) return
        polling = true
        ui.post(object : Runnable {
            override fun run() {
                val id = downloadId
                if (id == -1L) {
                    polling = false
                    return
                }
                val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                var again = true
                dm.query(DownloadManager.Query().setFilterById(id))?.use { c ->
                    if (c.moveToFirst()) {
                        val st = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                        val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                        val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                        val reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                        if (st == DownloadManager.STATUS_SUCCESSFUL) {
                            emit("ok", done, total)
                            again = false
                        } else if (st == DownloadManager.STATUS_FAILED) {
                            emit("fail", done, total, reason)
                            again = false
                        } else {
                            emit(if (st == DownloadManager.STATUS_PAUSED) "pause" else "run", done, total, reason)
                        }
                    } else {
                        emit("cancel", 0L, -1L)
                        again = false
                    }
                }
                if (again) {
                    ui.postDelayed(this, 500)
                } else {
                    polling = false
                }
            }
        })
    }

    fun cancel(activity: Activity) {
        val id = downloadId
        if (id != -1L) {
            val dm = activity.applicationContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            dm.remove(id)
            downloadId = -1L
        }
        emit("cancel", 0L, -1L)
    }

    private fun urlAllowed(uri: Uri): Boolean {
        if (uri.scheme?.lowercase() != "https") return false
        if (uri.host?.lowercase() != "github.com") return false
        return uri.path?.startsWith("/suscersal/maxclient/releases/download/") == true
    }

    fun start(activity: Activity, url: String, name: String, toMain: (String) -> Unit) {
        report = toMain
        val uri = Uri.parse(url)
        if (!urlAllowed(uri)) {
            toast(activity, "Недопустимый адрес обновления")
            emit("fail", 0L, -1L, -1)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
            toast(activity, "Разрешите установку из этого приложения и нажмите «Установить» ещё раз")
            emit("perm", 0L, -1L)
            try {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
                )
            } catch (e: Exception) {
                // нет экрана настроек — пользователь разрешит вручную
            }
            return
        }
        val app = activity.applicationContext
        val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        register(app)
        var safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_")
        if (!safe.endsWith(".apk")) safe += ".apk"
        val req = DownloadManager.Request(uri)
            .setTitle("MAX Client: обновление")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, safe)
        downloadId = dm.enqueue(req)
        emit("run", 0L, -1L)
        poll(app)
    }

    private fun register(app: Context) {
        if (registered) return
        registered = true
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) ?: -1L
                if (id == -1L || id != downloadId) return
                val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                val uri = dm.getUriForDownloadedFile(id)
                if (uri == null) {
                    toast(app, "Не удалось скачать обновление")
                    return
                }
                val install = Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try {
                    app.startActivity(install)
                } catch (e: Exception) {
                    toast(app, "Не удалось открыть установщик")
                }
            }
        }
        // ACTION_DOWNLOAD_COMPLETE шлёт системный процесс; на Android 14+ флаг экспорта обязателен
        ContextCompat.registerReceiver(
            app, receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), ContextCompat.RECEIVER_EXPORTED
        )
    }

    private fun toast(ctx: Context, text: String) {
        Toast.makeText(ctx, text, Toast.LENGTH_LONG).show()
    }
}
