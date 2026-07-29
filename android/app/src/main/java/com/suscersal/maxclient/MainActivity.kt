package com.suscersal.maxclient

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

class MainActivity : AppCompatActivity() {

    companion object {
        // ВАЖНО: это состояние процесса, а не Activity — MainActivity
        // пересоздаётся почти при каждом повторном открытии приложения
        // (смена конфигурации, возврат из фона), а сам процесс/Python-
        // интерпретатор/уже слушающий Flask-сервер при этом обычно
        // остаются жить. Раньше этот флаг был полем Activity и после
        // каждого пересоздания снова становился false, из-за чего
        // startPythonServerOnce пытался запустить сервер повторно в уже
        // живом процессе: `import bridge` возвращал закэшированный старый
        // модуль (свежескачанный hot-patch на диске игнорировался), а
        // повторный bridge.app.run() пытался занять уже занятый порт.
        // Итог: после первого холодного запуска новые hot-update'ы
        // скачивались на диск, но никогда не подхватывались, пока
        // приложение не закрывали полностью (не убивали процесс).
        private var serverStartedInProcess = false
    }

    private val port = 8080

    private val notifChannelId = "max_client_messages"
    private var notifIdCounter = 1

    // Колбэк WebView, ожидающий результат выбора файла (см. onShowFileChooser
    // ниже) — сохраняется здесь между запуском SAF-интента и получением
    // результата в fileChooserLauncher.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    // ActivityResultLauncher обязательно регистрировать безусловно на этапе
    // инициализации Activity (а не внутри onCreate/лямбды-обработчика клика),
    // иначе AndroidX упадёт с ошибкой "LifecycleOwner is attempting to
    // register while current state is STARTED".
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        if (callback == null) return@registerForActivityResult

        val data = result.data
        if (result.resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val uris = mutableListOf<Uri>()
        val clipData = data.clipData
        if (clipData != null) {
            for (i in 0 until clipData.itemCount) {
                uris.add(clipData.getItemAt(i).uri)
            }
        } else {
            data.data?.let { uris.add(it) }
        }
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }

        createNotificationChannel()
        requestNotificationPermissionIfNeeded()

        val webView = findViewById<WebView>(R.id.webview)
        val loadingGif = findViewById<GifView>(R.id.loadingGif)
        val loadingStatus = findViewById<TextView>(R.id.loadingStatus)

        // Копия loading.gif зашита в APK как нативный ассет (см.
        // scripts/sync-android-python.sh) — Flask-сервер на этом этапе ещё
        // не поднялся, раздавать её ему пока нечем.
        loadingGif.setGifFromAssets("loading.gif")

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            // onPageCommitVisible срабатывает, как только WebView отрисовал
            // первый видимый кадр страницы — раньше, чем onPageFinished
            // (который ждёт полной догрузки всех ресурсов). Благодаря этому
            // нативный спиннер убирается сразу, как только на экране
            // появляется собственный GUI/лоадер сайта, а не закрывает его
            // до самого конца загрузки.
            override fun onPageCommitVisible(view: WebView?, url: String?) {
                super.onPageCommitVisible(view, url)
                loadingGif.visibility = View.GONE
                loadingStatus.visibility = View.GONE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadingGif.visibility = View.GONE
                loadingStatus.visibility = View.GONE
            }
        }

        // Обычный system WebView НЕ показывает системный проводник для
        // <input type="file"> сам по себе — этим обязан заниматься
        // WebChromeClient.onShowFileChooser() хост-приложения. Используем
        // ACTION_OPEN_DOCUMENT (SAF) вместо ACTION_GET_CONTENT: он даёт
        // полноценный системный проводник (Файлы, Google Drive и т.д.), а не
        // урезанный чузер "недавних" файлов, который на части устройств
        // подставляется под GET_CONTENT.
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                // Если предыдущий запрос почему-то не был закрыт — не
                // оставляем его висеть, иначе WebView может застрять в
                // ожидании ответа навсегда.
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(
                        Intent.EXTRA_ALLOW_MULTIPLE,
                        fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                    )
                    val mimeTypes = fileChooserParams?.acceptTypes
                        ?.filter { it.isNotBlank() && it != "*/*" }
                        ?.toTypedArray()
                    if (!mimeTypes.isNullOrEmpty()) {
                        putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes)
                    }
                }

                return try {
                    fileChooserLauncher.launch(intent)
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    filePathCallback?.onReceiveValue(null)
                    false
                }
            }
        }

        // Обычный WebView НЕ реализует Web Notification API сам по себе —
        // window.Notification там просто не работает. Даём JS доступ к
        // настоящим системным уведомлениям Android через этот мост.
        webView.addJavascriptInterface(AndroidNotificationBridge(this), "AndroidNotification")

        loadingStatus.visibility = View.VISIBLE

        // OtaUpdater.checkAndUpdate сама ловит сетевые ошибки и не должна
        // зависать дольше своих HTTP-таймаутов (~8-16 сек), но если сети нет
        // вообще (DNS-резолвинг иногда виснет дольше connectTimeout) —
        // подстраховываемся отдельным таймером, чтобы приложение в любом
        // случае стартовало на уже скачанном ранее hotpatch'е (или на коде
        // из APK, если ничего ещё не скачивалось), а не стояло на заставке
        // бесконечно.
        val proceededOnce = java.util.concurrent.atomic.AtomicBoolean(false)

        fun proceedWithHotpatch(hotpatchDir: File?) {
            if (!proceededOnce.compareAndSet(false, true)) return
            loadingStatus.text = "Запуск…"
            startPythonServerOnce(hotpatchDir)
            waitForServerThenLoad(webView)
        }

        android.os.Handler(mainLooper).postDelayed({
            if (!proceededOnce.get()) {
                val dir = OtaUpdater.hotpatchDir(this)
                val existing = if (dir.exists() && dir.listFiles()?.isNotEmpty() == true) dir else null
                loadingStatus.text = "Нет соединения, запуск без обновлений…"
                proceedWithHotpatch(existing)
            }
        }, 5000)

        Thread {
            OtaUpdater.checkAndUpdate(this, object : OtaUpdater.ProgressListener {
                override fun onProgress(percent: Int, statusText: String) {
                    runOnUiThread { loadingStatus.text = statusText }
                }

                override fun onFinished(hotpatchDir: File?, updated: Boolean) {
                    runOnUiThread {
                        if (updated && serverStartedInProcess) {
                            // Сервер в этом процессе уже когда-то запускался
                            // со старым кодом — "на лету" его не подменить
                            // (модуль bridge уже импортирован и закэширован
                            // Python'ом, порт уже занят). Единственный
                            // надёжный способ подхватить свежескачанный
                            // bridge.py — перезапустить процесс целиком.
                            loadingStatus.text = "Обновление готово, перезапуск…"
                            restartProcessToApplyUpdate()
                            return@runOnUiThread
                        }
                        proceedWithHotpatch(hotpatchDir)
                    }
                }
            })
        }.start()
    }

    /** Полный перезапуск приложения — единственный надёжный способ подхватить
     * hot-patch, скачанный поверх уже работающего в этом процессе сервера. */
    private fun restartProcessToApplyUpdate() {
        val intent = packageManager.getLaunchIntentForPackage(packageName)
        intent?.addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK or android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
        Runtime.getRuntime().exit(0)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Результат сам отразится на способности AndroidNotificationBridge
        // показывать уведомления дальше — дополнительно ничего делать не нужно.
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                notifChannelId,
                "Сообщения MAX Client",
                NotificationManager.IMPORTANCE_HIGH
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    1001
                )
            }
        }
    }

    private fun startPythonServerOnce(hotpatchDir: File?) {
        if (serverStartedInProcess) return
        serverStartedInProcess = true

        val sessionFile = File(filesDir, "session.json").absolutePath
        val hotpatchPath = hotpatchDir?.absolutePath ?: ""

        Thread {
            val py = Python.getInstance()
            val launcher = py.getModule("bridge_launcher")
            launcher.callAttr("start_server", sessionFile, port, hotpatchPath)
        }.start()
    }

    private fun waitForServerThenLoad(webView: WebView) {
        Thread {
            var up = false
            var attempts = 0
            while (!up && attempts < 200) {
                attempts++
                try {
                    Socket().use { s ->
                        s.connect(InetSocketAddress("127.0.0.1", port), 300)
                        up = true
                    }
                } catch (e: Exception) {
                    Thread.sleep(200)
                }
            }
            runOnUiThread {
                // Это чисто локальная проверка (127.0.0.1) — интернет тут ни
                // при чём, но на случай, если сервер всё же не поднялся
                // (например, ошибка в Python-коде), не оставляем пользователя
                // молча смотреть на спиннер вечно, а показываем сообщение.
                if (up) {
                    findViewById<TextView>(R.id.loadingStatus).visibility = View.VISIBLE
                    webView.loadUrl("http://127.0.0.1:$port/")
                } else {
                    findViewById<TextView>(R.id.loadingStatus).text =
                        "Не удалось запустить локальный сервер.\nПерезапустите приложение."
                }
            }
        }.start()
    }

    /** Мост JS -> системные уведомления Android. Вызывается из index.html. */
    inner class AndroidNotificationBridge(private val ctx: Context) {

        @JavascriptInterface
        fun isAvailable(): Boolean = true

        @JavascriptInterface
        fun hasPermission(): Boolean {
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
                    PackageManager.PERMISSION_GRANTED
            } else {
                true
            }
        }//заглушка чтобы запустить сборку

        @JavascriptInterface
        fun show(title: String, body: String) {
            if (!hasPermission()) return
            val builder = NotificationCompat.Builder(ctx, notifChannelId)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
            NotificationManagerCompat.from(ctx).notify(notifIdCounter++, builder.build())
        }
    }
}