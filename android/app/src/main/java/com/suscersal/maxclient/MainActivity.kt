package com.suscersal.maxclient

import android.Manifest
import android.provider.DocumentsContract
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.widget.Toast
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

        private const val NOTIFICATIONS_PERMISSION_REQUEST_CODE = 1001
        private const val CONTACTS_PERMISSION_REQUEST_CODE = 1002
        private const val STORAGE_PERMISSION_REQUEST_CODE = 1003
    }

    private val port = 8080

    private val notifChannelId = "max_client_messages"
    private var notifIdCounter = 1

    // Колбэк WebView, ожидающий результат выбора файла (см. onShowFileChooser
    // ниже) — сохраняется здесь между запуском SAF-интента и получением
    // результата в fileChooserLauncher.
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    // Нужен как поле (а не локальная переменная onCreate), чтобы можно было
    // дёрнуть evaluateJavascript из onRequestPermissionsResult — на момент
    // получения результата запроса разрешения на контакты сам onCreate уже
    // давно отработал.
    private lateinit var webView: WebView

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
    private var pendingModelImportId: String? = null

    // Импорт одного .task-файла модели через SAF (ACTION_OPEN_DOCUMENT).
    private val modelImportFileLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val modelId = pendingModelImportId
        pendingModelImportId = null
        val uri = if (result.resultCode == RESULT_OK) result.data?.data else null
        handleModelImportResult(uri, modelId)
    }

    // Выбор папки (например "Загрузки") для поиска уже скачанных .task-файлов.
    private val modelScanTreeLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val treeUri = if (result.resultCode == RESULT_OK) result.data?.data else null
        handleModelScanResult(treeUri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }

        createNotificationChannel()
        requestNotificationPermissionIfNeeded()

        webView = findViewById(R.id.webview)
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

        // Обычный WebView сам по себе НЕ обрабатывает клики по прямым
        // ссылкам на файлы (a href="https://cdn/..." download): без
        // DownloadListener такой клик просто проглатывается — страница не
        // навигирует (это не html), а никакого скачивания не происходит.
        // Используется для downloadFileAttach() в index.html (реальные
        // ссылки на файлы с CDN, в отличие от фото/видео из просмотрщика,
        // которые идут через blob: и AndroidDownload-мост выше).
        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            try {
                val fileName = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = android.app.DownloadManager.Request(Uri.parse(url)).apply {
                    setNotificationVisibility(
                        android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                    )
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
                    setMimeType(mimeType)
                }
                val manager = getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
                manager.enqueue(request)
                Toast.makeText(this, "Загрузка начата: $fileName", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Ошибка загрузки: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }

        // Обычный WebView НЕ реализует Web Notification API сам по себе —
        // window.Notification там просто не работает. Даём JS доступ к
        // настоящим системным уведомлениям Android через этот мост.
        webView.addJavascriptInterface(AndroidNotificationBridge(this), "AndroidNotification")
        webView.addJavascriptInterface(AndroidModelImportBridge(this), "AndroidModelImport")

        // Мост JS -> локальные контакты телефона (для поиска по чатам и
        // контактам в web-интерфейсе). Разрешение READ_CONTACTS запрашивается
        // не здесь, а по требованию — методом requestPermission() из JS,
        // когда пользователь реально открывает локальный поиск, а не на
        // каждом запуске приложения.
        webView.addJavascriptInterface(AndroidContactsBridge(this), "AndroidContacts")

        // Мост JS -> сохранение фото/видео/gif из чата в галерею устройства.
        // Раньше JS пытался сохранять файлы через <a download> с blob:-ссылкой —
        // обычный system WebView такие "скачивания" тихо игнорирует (нет ни
        // DownloadListener, ни MediaStore-записи), поэтому JS показывал
        // "успешно сохранено", хотя по факту файла нигде не было.
        webView.addJavascriptInterface(AndroidDownloadBridge(this), "AndroidDownload")
        requestLegacyStoragePermissionIfNeeded()

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
        // Результат запроса на уведомления сам отразится на способности
        // AndroidNotificationBridge показывать уведомления дальше —
        // дополнительно ничего делать не нужно.
        if (requestCode == CONTACTS_PERMISSION_REQUEST_CODE) {
            val granted = grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED
            notifyContactsPermissionResult(granted)
        }
        // STORAGE_PERMISSION_REQUEST_CODE: специально ничего не делаем — если
        // пользователь отказал, AndroidDownloadBridge.saveFile() просто вернёт
        // ошибку в момент реальной попытки сохранения, и JS покажет об этом
        // сообщение (см. downloadBlobUrl в index.html).
    }

    /** Сообщает web-странице результат запроса READ_CONTACTS — вызывает
     * window.onAndroidContactsPermissionResult(granted), если она определена. */
    private fun notifyContactsPermissionResult(granted: Boolean) {
        runOnUiThread {
            webView.evaluateJavascript(
                "window.onAndroidContactsPermissionResult && window.onAndroidContactsPermissionResult($granted);",
                null
            )
        }
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

    /** На API 24-28 запись в публичную галерею требует WRITE_EXTERNAL_STORAGE
     * (на API 29+ используется scoped storage через MediaStore без него). */
    private fun requestLegacyStoragePermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE),
                    STORAGE_PERMISSION_REQUEST_CODE
                )
            }
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
                    NOTIFICATIONS_PERMISSION_REQUEST_CODE
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
            // applicationContext (а не this/Activity!) — он переживает
            // пересоздание Activity и не течёт: on-device ИИ-модель
            // (MediaPipe, см. bridge.py/get_on_device_llm) держит эту
            // ссылку в Python-модуле всё время жизни процесса.
            launcher.callAttr("start_server", sessionFile, port, hotpatchPath, applicationContext)
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
    // Имена .task-файлов, которые ждёт bridge.py (см. ONDEVICE_MODELS там же) —
    // держи синхронизированным вручную при добавлении новых моделей в каталог.
    private val ondeviceModelFiles = mapOf(
        "gemma3-1b-q4_0-web" to "gemma3-1b-it-q4_0-web.task",
        "gemma3-1b-int4" to "gemma3-1b-it-int4.task"
    )

    private fun jsStr(s: String): String = org.json.JSONObject.quote(s)

    /** Копирует SAF-Uri в filesDir/targetName — та же папка, где bridge.py
     * ищет .task-модель. Пишет во временный .part и атомарно переименовывает,
     * чтобы прерванная копия не оставляла битый файл (как и при скачивании). */
    private fun copyUriToModelFile(uri: Uri, targetName: String): String? {
        return try {
            val target = File(filesDir, targetName)
            val tmp = File(filesDir, "$targetName.part")
            contentResolver.openInputStream(uri)?.use { input ->
                tmp.outputStream().use { output -> input.copyTo(output) }
            } ?: return "не удалось открыть выбранный файл"
            if (!tmp.renameTo(target)) return "не удалось сохранить файл модели"
            null
        } catch (e: SecurityException) {
            "нет доступа к выбранному файлу"
        } catch (e: Exception) {
            "error: ${e.message ?: e.javaClass.simpleName}"
        }
    }

    private fun handleModelImportResult(uri: Uri?, modelId: String?) {
        val js = if (uri == null || modelId == null) {
            "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:false,error:'Файл не выбран'});"
        } else {
            val targetName = ondeviceModelFiles[modelId]
            if (targetName == null) {
                "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:false,error:'Неизвестная модель'});"
            } else {
                val err = copyUriToModelFile(uri, targetName)
                if (err == null)
                    "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:true,modelId:${jsStr(modelId)}});"
                else
                    "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:false,error:${jsStr(err)}});"
            }
        }
        runOnUiThread { webView.evaluateJavascript(js, null) }
    }

    /** Перечисляет *.task в выбранной папке через SAF (без чтения содержимого). */
    private fun handleModelScanResult(treeUri: Uri?) {
        if (treeUri == null) {
            runOnUiThread {
                webView.evaluateJavascript(
                    "window.onAndroidModelScanResult && window.onAndroidModelScanResult({ok:false,error:'Папка не выбрана'});",
                    null
                )
            }
            return
        }
        Thread {
            val found = mutableListOf<Pair<String, String>>()
            try {
                val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
                val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocId)
                contentResolver.query(
                    childrenUri,
                    arrayOf(
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME
                    ),
                    null, null, null
                )?.use { cursor ->
                    val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    while (cursor.moveToNext()) {
                        val name = cursor.getString(nameIdx) ?: continue
                        if (!name.endsWith(".task", ignoreCase = true)) continue
                        val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idIdx))
                        found.add(name to docUri.toString())
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.onAndroidModelScanResult && window.onAndroidModelScanResult({ok:false,error:${jsStr(e.message ?: "scan failed")}});",
                        null
                    )
                }
                return@Thread
            }
            val itemsJson = found.joinToString(",") { (name, uriStr) ->
                "{\"name\":${jsStr(name)},\"uri\":${jsStr(uriStr)}}"
            }
            runOnUiThread {
                webView.evaluateJavascript(
                    "window.onAndroidModelScanResult && window.onAndroidModelScanResult({ok:true,items:[$itemsJson]});",
                    null
                )
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

    /** Мост JS -> локальные контакты телефона (READ_CONTACTS). Разрешение
     * уже объявлено в AndroidManifest.xml, но, начиная с API 23, само по себе
     * это ничего не даёт — без runtime-запроса ContentResolver просто вернёт
     * пустой курсор (или кинет SecurityException на некоторых прошивках). */
    inner class AndroidContactsBridge(private val ctx: Context) {

        @JavascriptInterface
        fun isAvailable(): Boolean = true

        @JavascriptInterface
        fun hasPermission(): Boolean {
            return ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CONTACTS) ==
                PackageManager.PERMISSION_GRANTED
        }

        /** Запускает системный диалог запроса разрешения. Асинхронно —
         * результат прилетит в window.onAndroidContactsPermissionResult(granted)
         * (см. notifyContactsPermissionResult). Если разрешение уже есть,
         * колбэк дёргается сразу же с granted=true. */
        @JavascriptInterface
        fun requestPermission() {
            runOnUiThread {
                if (hasPermission()) {
                    notifyContactsPermissionResult(true)
                } else {
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.READ_CONTACTS),
                        CONTACTS_PERMISSION_REQUEST_CODE
                    )
                }
            }
        }

        /** Android не даёт приложению самому отозвать у себя разрешение —
         * единственный способ дать пользователю это сделать — открыть
         * системный экран "Сведения о приложении", где есть свой пункт
         * "Разрешения". Используется кнопкой "Отозвать доступ" в JS. */
        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread {
                val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.fromParts("package", ctx.packageName, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                ctx.startActivity(intent)
            }
        }

        /** Возвращает JSON-массив вида [{"name":"...","phone":"..."}, ...] —
         * по одной строке на каждый номер телефона из адресной книги
         * устройства. Без разрешения возвращает "[]", не бросая исключений,
         * чтобы JS-стороне не нужно было оборачивать вызов в try/catch. */
        @JavascriptInterface
        fun getContacts(): String {
            if (!hasPermission()) return "[]"
            val result = org.json.JSONArray()
            val projection = arrayOf(
                android.provider.ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER
            )
            try {
                ctx.contentResolver.query(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    projection, null, null, null
                )?.use { cursor ->
                    val nameIdx = cursor.getColumnIndex(projection[0])
                    val numberIdx = cursor.getColumnIndex(projection[1])
                    while (cursor.moveToNext()) {
                        val number = if (numberIdx >= 0) cursor.getString(numberIdx) else null
                        if (number.isNullOrBlank()) continue
                        val name = if (nameIdx >= 0) cursor.getString(nameIdx) else null
                        val obj = org.json.JSONObject()
                        obj.put("name", name ?: "")
                        obj.put("phone", number)
                        result.put(obj)
                    }
                }
            } catch (e: SecurityException) {
                // Разрешение отозвали между hasPermission() и запросом —
                // просто отдаём то, что успели собрать.
            }
            return result.toString()
        }
    }

    /** Мост JS -> сохранение файла (фото/gif/видео) в публичную галерею
     * устройства. Обычный `<a download>` c blob:-ссылкой, который использует
     * index.html, в system WebView ничего не сохраняет — там нет ни
     * DownloadListener (он не срабатывает для blob:), ни доступа к
     * MediaStore, поэтому JS раньше просто врал об успехе. Здесь JS передаёт
     * содержимое файла как base64, а метод сам решает, в какую коллекцию
     * MediaStore его положить, по mimeType. */
    inner class AndroidDownloadBridge(private val ctx: Context) {

        @JavascriptInterface
        fun isAvailable(): Boolean = true

        /** Сохраняет файл в галерею. Возвращает "true" при успехе, иначе
         * текст ошибки (начинается с "error:") — так JS может показать
         * пользователю осмысленное сообщение без лишнего try/catch на своей
         * стороне. Вызывается синхронно из JS (обычный JavascriptInterface). */
        @JavascriptInterface
        fun saveFile(base64Data: String, filename: String, mimeType: String): String {
            return try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val isVideo = mimeType.startsWith("video/")
                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveViaMediaStoreQ(bytes, filename, mimeType, isVideo)
                } else {
                    saveViaLegacyStorage(bytes, filename, mimeType, isVideo)
                }
                if (uri == null) {
                    "error: не удалось создать файл (нет доступа к хранилищу)"
                } else {
                    runOnUiThread {
                        Toast.makeText(
                            ctx,
                            "Сохранено: $filename",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    "true"
                }
            } catch (e: SecurityException) {
                "error: нет разрешения на запись в хранилище"
            } catch (e: Exception) {
                "error: ${e.message ?: e.javaClass.simpleName}"
            }
        }

        private fun saveViaMediaStoreQ(
            bytes: ByteArray,
            filename: String,
            mimeType: String,
            isVideo: Boolean
        ): Uri? {
            val collection = if (isVideo) {
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            } else {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }
            val relativeDir = if (isVideo) "Movies/MaxClient" else "Pictures/MaxClient"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, filename)
                put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relativeDir)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = ctx.contentResolver
            val uri = resolver.insert(collection, values) ?: return null
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return null
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri
        }

        /** API 24-28: scoped storage ещё нет, MediaStore.RELATIVE_PATH не
         * существует — пишем напрямую в публичную директорию и сканируем
         * файл, чтобы он тут же появился в галерее. Требует
         * WRITE_EXTERNAL_STORAGE (см. requestLegacyStoragePermissionIfNeeded). */
        private fun saveViaLegacyStorage(
            bytes: ByteArray,
            filename: String,
            mimeType: String,
            isVideo: Boolean
        ): Uri? {
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED
            ) {
                return null
            }
            val publicDir = Environment.getExternalStoragePublicDirectory(
                if (isVideo) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES
            )
            val targetDir = File(publicDir, "MaxClient").apply { mkdirs() }
            val targetFile = File(targetDir, filename)
            targetFile.writeBytes(bytes)
            android.media.MediaScannerConnection.scanFile(
                ctx, arrayOf(targetFile.absolutePath), arrayOf(mimeType), null
            )
            return Uri.fromFile(targetFile)
        }
    }
    /** Мост JS -> импорт уже скачанной .task-модели с устройства (например
     * из "Загрузки", если скачал вручную браузером). Копирует файл в ту же
     * папку, где bridge.py ищет модель — дальше подхватывается как обычно. */
    inner class AndroidModelImportBridge(private val ctx: Context) {

        @JavascriptInterface
        fun isAvailable(): Boolean = true

        @JavascriptInterface
        fun pickAndImport(modelId: String) {
            pendingModelImportId = modelId
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
            }
            runOnUiThread {
                try {
                    modelImportFileLauncher.launch(intent)
                } catch (e: Exception) {
                    pendingModelImportId = null
                    webView.evaluateJavascript(
                        "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:false,error:${jsStr(e.message ?: "не удалось открыть проводник")}});",
                        null
                    )
                }
            }
        }

        @JavascriptInterface
        fun scanFolder() {
            runOnUiThread {
                try {
                    modelScanTreeLauncher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE))
                } catch (e: Exception) {
                    webView.evaluateJavascript(
                        "window.onAndroidModelScanResult && window.onAndroidModelScanResult({ok:false,error:${jsStr(e.message ?: "не удалось открыть проводник")}});",
                        null
                    )
                }
            }
        }

        @JavascriptInterface
        fun importFromUri(uriString: String, modelId: String) {
            Thread {
                val err = ondeviceModelFiles[modelId]?.let { copyUriToModelFile(Uri.parse(uriString), it) }
                    ?: "Неизвестная модель"
                val js = if (err == null)
                    "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:true,modelId:${jsStr(modelId)}});"
                else
                    "window.onAndroidModelImportResult && window.onAndroidModelImportResult({ok:false,error:${jsStr(err)}});"
                runOnUiThread { webView.evaluateJavascript(js, null) }
            }.start()
        }
    }
}