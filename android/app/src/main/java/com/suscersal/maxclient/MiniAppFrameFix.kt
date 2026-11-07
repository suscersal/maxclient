package com.suscersal.maxclient

import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Мини-приложения MAX (например, ugc-stickers.max.ru) запрещают встраивание в чужие страницы
 * (заголовки X-Frame-Options / CSP frame-ancestors), а Web K в APK показывает их в <iframe> на 127.0.0.1 —
 * Chrome пишет «Сайт не позволяет установить соединение». У Komet такой проблемы нет: там мини-приложение
 * открывается в отдельном WebView. Здесь для документов во фреймах с хостов *.max.ru мы сами делаем GET
 * и отдаём ответ без этих заголовков. Скрипты, картинки и XHR страницы не трогаем.
 * Хосты: экосистема MAX/Сферум (список ниже) плюс адреса, которые выдал сам MAX при запуске мини-приложения
 * (JS регистрирует их через AndroidMiniApp.allowFrameHost) и хосты редиректов с уже разрешённых адресов.
 *
 * Диагностика: logcat, тег MiniAppFrameFix.
 */
object MiniAppFrameFix {
    private const val TAG = "MiniAppFrameFix"

    fun intercept(request: WebResourceRequest?): WebResourceResponse? {
        if (request == null) return null
        return try {
            fetch(request)
        } catch (e: Exception) {
            Log.w(TAG, "не удалось обработать ${request.url}: ${e.message}")
            null
        }
    }

    // max.ru, oneme.ru — MAX; sferum.ru и sferum-dev.ru — «Сферум» (его адрес выдаёт сервер: frontend.sferum-dev.ru)
    private val staticSuffixes = listOf("max.ru", "oneme.ru", "sferum.ru", "sferum-dev.ru")
    private val dynamicHosts = LinkedHashSet<String>()

    /** Разрешить обход для точного хоста (только https; список ограничен 64 хостами). */
    fun allowHost(host: String?) {
        val h = host?.lowercase() ?: return
        if (h.isEmpty() || h.length > 253) return
        synchronized(dynamicHosts) {
            if (dynamicHosts.size >= 64) dynamicHosts.remove(dynamicHosts.first())
            dynamicHosts.add(h)
        }
    }

    private fun isAllowedHost(host: String?): Boolean {
        val h = host?.lowercase() ?: return false
        if (staticSuffixes.any { h == it || h.endsWith(".$it") }) return true
        return synchronized(dynamicHosts) { dynamicHosts.contains(h) }
    }

    private fun stripFrameAncestors(csp: String): String =
        csp.split(";")
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.lowercase().startsWith("frame-ancestors") }
            .joinToString("; ")

    private fun fetch(request: WebResourceRequest): WebResourceResponse? {
        if (request.isForMainFrame || !request.method.equals("GET", ignoreCase = true)) return null
        val uri: Uri = request.url
        if (uri.scheme?.lowercase() != "https" || !isAllowedHost(uri.host)) return null
        val reqHeaders = request.requestHeaders ?: return null
        val accept = reqHeaders.entries.firstOrNull { it.key.equals("Accept", ignoreCase = true) }?.value ?: ""
        // только документы (iframe), не XHR/скрипты/картинки
        if (!accept.contains("text/html", ignoreCase = true)) return null

        val conn = URL(uri.toString()).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false
        conn.connectTimeout = 15000
        conn.readTimeout = 20000
        for ((k, v) in reqHeaders) {
            if (k.equals("Accept-Encoding", true) || k.equals("Host", true) || k.equals("Cookie", true)) continue
            conn.setRequestProperty(k, v)
        }
        val cookie = CookieManager.getInstance().getCookie(uri.toString())
        if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)

        val code = conn.responseCode
        val xfo = conn.getHeaderField("X-Frame-Options")
        val csp = conn.getHeaderField("Content-Security-Policy")
        Log.i(TAG, "${uri.host}${uri.path}: HTTP $code, X-Frame-Options=$xfo, CSP frame-ancestors=${csp?.contains("frame-ancestors", ignoreCase = true)}")

        // Set-Cookie кладём в общее хранилище WebView
        conn.headerFields?.forEach { (name, values) ->
            if (name != null && name.equals("Set-Cookie", ignoreCase = true)) {
                values.forEach { CookieManager.getInstance().setCookie(uri.toString(), it) }
            }
        }

        // WebResourceResponse не умеет 3xx — переход делаем сами, страница-прослойка перенаправит фрейм
        if (code in 300..399) {
            val loc = conn.getHeaderField("Location") ?: return null
            val target = try {
                URL(URL(uri.toString()), loc).toString()
            } catch (e: Exception) {
                return null
            }
            // цепочка редиректов с уже разрешённого адреса остаётся в доверенной зоне
            try {
                val tu = Uri.parse(target)
                if (tu.scheme?.lowercase() == "https") allowHost(tu.host)
            } catch (e: Exception) {
            }
            val html = "<!doctype html><meta charset=utf-8><script>location.replace(${org.json.JSONObject.quote(target)})</script>"
            return WebResourceResponse("text/html", "utf-8", 200, "OK", HashMap(), ByteArrayInputStream(html.toByteArray(Charsets.UTF_8)))
        }

        val out = HashMap<String, String>()
        conn.headerFields?.forEach { (name, values) ->
            if (name == null || values.isNullOrEmpty()) return@forEach
            when (name.lowercase()) {
                "x-frame-options", "cross-origin-resource-policy", "content-security-policy-report-only", "set-cookie",
                "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive" -> {}
                "content-security-policy" -> {
                    val c = values.map { stripFrameAncestors(it) }.filter { it.isNotEmpty() }.joinToString(", ")
                    if (c.isNotEmpty()) out[name] = c
                }
                else -> out[name] = values.joinToString(", ")
            }
        }

        val stream = (if (code >= 400) conn.errorStream else conn.inputStream) ?: ByteArrayInputStream(ByteArray(0))
        val ct = conn.contentType ?: "text/html; charset=utf-8"
        val mime = ct.substringBefore(';').trim().ifEmpty { "text/html" }
        val charset = Regex("charset=([^;]+)", RegexOption.IGNORE_CASE).find(ct)?.groupValues?.get(1)?.trim()?.trim('"') ?: "utf-8"
        val reason = conn.responseMessage?.takeIf { it.isNotEmpty() } ?: "OK"
        return WebResourceResponse(mime, charset, code, reason, out, stream)
    }
}

/** Мост JS -> регистрация хоста мини-приложения для обхода запрета встраивания (см. MiniAppFrameFix). */
class AndroidMiniAppBridge {

    @JavascriptInterface
    fun allowFrameHost(url: String?) {
        if (url.isNullOrEmpty()) return
        val u = Uri.parse(url)
        if (u.scheme?.lowercase() != "https") return
        MiniAppFrameFix.allowHost(u.host)
    }
}
