package com.suscersal.maxclient

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.Gravity
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * Нативное окно мини-приложения по образцу Komet (lib/frontend/screens/webapp/web_app_screen.dart + web_app_bridge.dart).
 *
 * Мини-приложение MAX/«Сферум» открывается отдельным WebView как ГЛАВНАЯ страница, а не в iframe: так у него cookie первой
 * стороны, оно не упирается в X-Frame-Options и видит window.WebViewHandler — родной мост MAX SDK.
 * Протокол моста (как в Komet): страница шлёт window.WebViewHandler.postEvent(имя, JSON-строка), мы отвечаем
 * window.WebApp.sendEvent(имя, JSON-строка). Закрытие, «Назад» и подтверждение закрытия обрабатываются здесь,
 * всё остальное (телефон, ссылки, «поделиться» …) уходит в mx-ui.js (window.__mxWinEvent) — с подтверждениями пользователя.
 *
 * Диагностика: кнопка «Лог» в шапке копирует в буфер ошибки загрузки, HTTP >= 400 и console.error страницы.
 */
class AndroidMiniAppWinBridge(private val activity: Activity, private val toMain: (String) -> Unit) {

    private var dialog: Dialog? = null
    private var web: WebView? = null
    private var winId = 0L
    private var botId = 0L
    private var backVisible = false
    private var needConfirm = false
    private val diag = ArrayList<String>()

    @JavascriptInterface
    fun isOpen(): Boolean = dialog != null

    /** Открыть мини-приложение (url — подписанный адрес из web-app-init). bot нужен для телефона и хранилища. */
    @JavascriptInterface
    fun open(url: String?, title: String?, bot: Double) {
        if (url.isNullOrEmpty()) return
        val t = title ?: ""
        val b = bot.toLong()
        activity.runOnUiThread { openInternal(url, t, b) }
    }

    /** Загрузить новый адрес в уже открытое окно (после externalCallback), иначе открыть новое. */
    @JavascriptInterface
    fun reload(url: String?) {
        if (url.isNullOrEmpty()) return
        activity.runOnUiThread {
            val w = web
            if (w != null && dialog != null && isHttps(url)) {
                log("reload " + (Uri.parse(url).host ?: ""))
                w.loadUrl(url)
            } else {
                openInternal(url, "", 0L)
            }
        }
    }

    /** Ответ приложению (из mx-ui.js): payload — JSON-строка, как в Komet (_send → __kometWebAppDeliver). */
    @JavascriptInterface
    fun deliver(id: Double, name: String?, payload: String?) {
        if (name.isNullOrEmpty()) return
        val p = payload ?: "{}"
        activity.runOnUiThread {
            if (id.toLong() == winId) deliverToPage(name, p)
        }
    }

    @JavascriptInterface
    fun close() {
        activity.runOnUiThread { dismissInternal() }
    }

    private fun isHttps(url: String): Boolean = Uri.parse(url).scheme?.lowercase() == "https"

    private fun log(text: String) {
        synchronized(diag) {
            if (diag.size >= 200) diag.removeAt(0)
            diag.add(java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date()) + " " + text)
        }
    }

    private fun isExternalCallback(u: Uri): Boolean =
        try { u.getQueryParameter("externalCallback") == "1" } catch (e: Exception) { false }

    private fun deliverToPage(name: String, payload: String) {
        // как __kometWebAppDeliver: пока MAX SDK не создал window.WebApp, события ждут в очереди
        val js = "(function(n,d){var q=window.__mxq||(window.__mxq=[]);q.push([n,d]);if(window.__mxqT)return;" +
            "window.__mxqT=setInterval(function(){var b=window.WebApp;if(!(b&&typeof b.sendEvent==='function'))return;" +
            "while(q.length){var i=q.shift();try{b.sendEvent(i[0],i[1])}catch(e){}}" +
            "clearInterval(window.__mxqT);window.__mxqT=0},50)})(" +
            JSONObject.quote(name) + "," + JSONObject.quote(payload) + ")"
        web?.evaluateJavascript(js, null)
    }

    private fun requestClose() {
        if (needConfirm) {
            AlertDialog.Builder(activity)
                .setMessage("Закрыть приложение?")
                .setPositiveButton("Закрыть") { _, _ -> dismissInternal() }
                .setNegativeButton("Отмена", null)
                .show()
        } else {
            dismissInternal()
        }
    }

    private fun handleBack() {
        val w = web ?: return
        if (backVisible) {
            deliverToPage("WebAppBackButtonPressed", "{}")
        } else if (w.canGoBack()) {
            w.goBack()
        } else {
            requestClose()
        }
    }

    private fun dismissInternal() {
        dialog?.dismiss()
    }

    private fun copyLog() {
        val text = synchronized(diag) { diag.joinToString("\n") }
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Лог мини-приложения", text))
        Toast.makeText(activity, "Лог скопирован (" + diag.size + " строк)", Toast.LENGTH_SHORT).show()
    }

    private fun openInternal(url: String, title: String, bot: Long) {
        if (!isHttps(url)) return
        dismissInternal()
        winId = System.currentTimeMillis()
        botId = bot
        backVisible = false
        needConfirm = false
        synchronized(diag) { diag.clear() }
        val id = winId
        log("открываю " + (Uri.parse(url).host ?: "") + " (bot " + bot + ")")

        val d = Dialog(activity, android.R.style.Theme_DeviceDefault_NoActionBar)
        val root = LinearLayout(activity)
        root.orientation = LinearLayout.VERTICAL
        val bar = LinearLayout(activity)
        bar.orientation = LinearLayout.HORIZONTAL
        bar.gravity = Gravity.CENTER_VERTICAL
        val pad = (8 * activity.resources.displayMetrics.density).toInt()
        bar.setPadding(pad, pad, pad, pad)
        val titleView = TextView(activity)
        titleView.text = if (title.isNotEmpty()) title else (Uri.parse(url).host ?: "")
        titleView.maxLines = 1
        titleView.ellipsize = android.text.TextUtils.TruncateAt.END
        bar.addView(titleView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val logBtn = Button(activity)
        logBtn.text = "Лог"
        val outBtn = Button(activity)
        outBtn.text = "Снаружи"
        val closeBtn = Button(activity)
        closeBtn.text = "Закрыть"
        bar.addView(logBtn)
        bar.addView(outBtn)
        bar.addView(closeBtn)

        val w = WebView(activity)
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mediaPlaybackRequiresUserGesture = false
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.javaScriptCanOpenWindowsAutomatically = false
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true)
        w.addJavascriptInterface(Handler(id), "WebViewHandler")
        w.addJavascriptInterface(PrivateHandler(), "PrivateWebViewHandler")

        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url ?: return false
                if (isExternalCallback(u)) {
                    // возврат из внешнего сценария (Цифровой ID и т.п.): mx-ui.js сделает op 105 → 160 и вызовет reload()
                    log("externalCallback перехвачен")
                    toMain("window.__mxExternalCallback&&window.__mxExternalCallback(" + JSONObject.quote(u.toString()) + ")")
                    return true
                }
                val sch = u.scheme?.lowercase()
                if (sch == "http" || sch == "https" || sch == "about" || sch == "data" || sch == "blob") return false
                if (sch == "javascript" || sch == "file" || sch == "content") return true
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, u))
                } catch (e: Exception) {
                    // нет приложения под схему — переход просто отменяем
                }
                return true
            }

            override fun onPageStarted(v: WebView?, u: String?, favicon: Bitmap?) {
                // как в шиме Komet: заглушка AndroidPerf на случай, если SDK её дёргает
                v?.evaluateJavascript("window.AndroidPerf=window.AndroidPerf||{trackFcp:function(){}}", null)
            }

            override fun onReceivedError(v: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                log("ОШИБКА " + (error?.description ?: "?") + " ← " + (request?.url ?: ""))
            }

            override fun onReceivedHttpError(v: WebView?, request: WebResourceRequest?, resp: WebResourceResponse?) {
                val code = resp?.statusCode ?: return
                if (code >= 400) log("HTTP " + code + " ← " + (request?.url ?: ""))
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage?): Boolean {
                if (m != null && (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING)) {
                    log("console." + m.messageLevel().name.lowercase() + ": " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")")
                }
                return true
            }
        }

        logBtn.setOnClickListener { copyLog() }
        outBtn.setOnClickListener {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(w.url ?: url)))
            } catch (e: Exception) {
                // нет браузера
            }
        }
        closeBtn.setOnClickListener { requestClose() }
        d.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
                handleBack()
                true
            } else {
                false
            }
        }
        d.setOnDismissListener {
            if (dialog === d) {
                dialog = null
                web = null
            }
            // destroy() нельзя вызывать внутри колбэка самого WebView — откладываем на следующий тик
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    w.stopLoading()
                    w.destroy()
                } catch (e: Exception) {
                }
            }
        }

        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(w, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        d.setContentView(root)
        d.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        dialog = d
        web = w
        d.show()
        w.loadUrl(url)
    }

    /** window.WebViewHandler — событие от MAX SDK страницы (поток JavaBridge, не UI). */
    inner class Handler(private val id: Long) {
        @JavascriptInterface
        fun postEvent(name: String?, data: String?) {
            if (name.isNullOrEmpty()) return
            when (name) {
                "WebAppClose" -> activity.runOnUiThread { dismissInternal() }
                "WebAppSetupBackButton" -> backVisible = flag(data, "isVisible")
                "WebAppSetupClosingBehavior" -> needConfirm = flag(data, "needConfirmation")
                "WebAppReady", "WebAppStat", "WebAppUrlInterceptor" -> {}
                else -> toMain(
                    "window.__mxWinEvent&&window.__mxWinEvent(" + id + "," + JSONObject.quote(name) + "," +
                        JSONObject.quote(data ?: "") + "," + botId + ")"
                )
            }
        }

        @JavascriptInterface
        fun resolveShare(requestId: String?, bytes: String?, mimeType: String?, fileName: String?) {
            // передача файлов в «поделиться» не поддерживается
        }

        private fun flag(data: String?, key: String): Boolean =
            try { JSONObject(data ?: "{}").optBoolean(key, false) } catch (e: Exception) { false }
    }

    /** window.PrivateWebViewHandler — служебный канал MAX SDK; в Komet он отдельный, у нас игнорируется. */
    inner class PrivateHandler {
        @JavascriptInterface
        fun postEvent(name: String?, data: String?) {
        }

        @JavascriptInterface
        fun resolveShare(requestId: String?, bytes: String?, mimeType: String?, fileName: String?) {
        }
    }
}
