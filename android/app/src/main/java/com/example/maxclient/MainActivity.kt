package com.example.maxclient

import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.appcompat.app.AppCompatActivity
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

class MainActivity : AppCompatActivity() {

    private val port = 8080
    private var serverStarted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }

        val webView = findViewById<WebView>(R.id.webview)
        val loading = findViewById<ProgressBar>(R.id.loading)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loading.visibility = View.GONE
            }
        }

        startPythonServerOnce()
        waitForServerThenLoad(webView)
    }

    private fun startPythonServerOnce() {
        if (serverStarted) return
        serverStarted = true

        // Файл сессии храним в приватной, доступной для записи папке
        // приложения — НЕ в assets/python (это была бы read-only копия
        // из APK). Токен, полученный после логина, будет жить только
        // на этом устройстве.
        val sessionFile = File(filesDir, "session.json").absolutePath

        Thread {
            val py = Python.getInstance()
            val launcher = py.getModule("bridge_launcher")
            launcher.callAttr("start_server", sessionFile, port)
        }.start()
    }

    private fun waitForServerThenLoad(webView: WebView) {
        Thread {
            var up = false
            var attempts = 0
            while (!up && attempts < 200) { // ~ до 40 секунд ожидания
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
                webView.loadUrl("http://127.0.0.1:$port/")
            }
        }.start()
    }
}
