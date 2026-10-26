package com.suscersal.maxclient

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebStorage
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Код-пароль приложения (как «Passcode Lock» в Telegram).
 * PIN хранится только как PBKDF2-хеш с солью. Состояние «разблокировано» живёт в памяти
 * процесса: после холодного старта приложение всегда заблокировано.
 */
object AppLock {
    private const val PREFS = "app_lock"
    private const val K_ENABLED = "enabled"
    private const val K_SALT = "salt"
    private const val K_HASH = "hash"
    private const val K_LEN = "pin_len"
    private const val K_TYPE = "secret_type"
    private const val K_TIMEOUT = "timeout_ms"
    private const val K_BIOMETRIC = "biometric"
    private const val K_PREVIEW = "show_preview"
    private const val K_FAILS = "fails"
    private const val K_LOCKED_UNTIL = "locked_until"
    private const val ITERATIONS = 120_000

    const val MIN_LEN = 4
    const val MAX_LEN = 8
    const val MIN_PASSWORD = 4
    const val MAX_PASSWORD = 64

    /** Автоблокировка: -1 — только при запуске приложения, иначе «если вне приложения дольше N мс». */
    const val TIMEOUT_ONLY_START = -1L
    val TIMEOUT_VALUES = longArrayOf(TIMEOUT_ONLY_START, 60_000L, 300_000L, 3_600_000L, 18_000_000L)
    val TIMEOUT_LABELS = arrayOf("Только при запуске", "Через 1 минуту", "Через 5 минут", "Через 1 час", "Через 5 часов")

    @Volatile
    private var unlocked = false
    @Volatile
    private var backgroundAt = 0L

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(ctx: Context): Boolean {
        val p = prefs(ctx)
        return p.getBoolean(K_ENABLED, false) && p.getString(K_HASH, null) != null
    }

    fun pinLength(ctx: Context): Int = prefs(ctx).getInt(K_LEN, MIN_LEN)

    /** true — вход по паролю (любые символы), false — PIN из цифр. */
    fun isPassword(ctx: Context): Boolean = prefs(ctx).getString(K_TYPE, "pin") == "password"
    fun timeoutMs(ctx: Context): Long = prefs(ctx).getLong(K_TIMEOUT, 60_000L)
    fun setTimeoutMs(ctx: Context, v: Long) {
        prefs(ctx).edit().putLong(K_TIMEOUT, v).apply()
    }

    fun biometricEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(K_BIOMETRIC, false)
    fun setBiometricEnabled(ctx: Context, v: Boolean) {
        prefs(ctx).edit().putBoolean(K_BIOMETRIC, v).apply()
    }

    fun showPreview(ctx: Context): Boolean = prefs(ctx).getBoolean(K_PREVIEW, false)
    fun setShowPreview(ctx: Context, v: Boolean) {
        prefs(ctx).edit().putBoolean(K_PREVIEW, v).apply()
    }

    /** При включённой блокировке и выключенном «показывать текст» уведомления без имени и текста. */
    fun hideNotificationContent(ctx: Context): Boolean = isEnabled(ctx) && !showPreview(ctx)

    // ---- состояние блокировки ----

    @Synchronized
    fun shouldLock(ctx: Context): Boolean {
        if (!isEnabled(ctx)) return false
        if (!unlocked) return true
        val t = timeoutMs(ctx)
        if (t >= 0 && backgroundAt > 0 && System.currentTimeMillis() - backgroundAt >= t) {
            unlocked = false
            return true
        }
        return false
    }

    /** Приложение ушло с экрана: запоминаем момент (только если было разблокировано). */
    @Synchronized
    fun onBackground() {
        if (unlocked && backgroundAt == 0L) backgroundAt = System.currentTimeMillis()
    }

    /** Приложение вернулось и блокировать не нужно. */
    @Synchronized
    fun onForegroundStillUnlocked() {
        backgroundAt = 0L
    }

    /** «Заблокировать сейчас» (кнопка-замочек в шапке, ярлык): следующий показ приложения запросит код. */
    @Synchronized
    fun lockNow(ctx: Context) {
        if (isEnabled(ctx)) {
            unlocked = false
            backgroundAt = 0L
        }
    }

    @Synchronized
    fun markUnlocked() {
        unlocked = true
        backgroundAt = 0L
    }

    // ---- PIN ----

    private fun hash(pin: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, ITERATIONS, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    fun setPin(ctx: Context, pin: String) = setSecret(ctx, pin, false)

    /** Пароль из любых символов (буквы, цифры, знаки, эмодзи). */
    fun setPassword(ctx: Context, password: String) = setSecret(ctx, password, true)

    private fun setSecret(ctx: Context, secret: String, password: Boolean) {
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        prefs(ctx).edit()
            .putString(K_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
            .putString(K_HASH, Base64.encodeToString(hash(secret, salt), Base64.NO_WRAP))
            .putInt(K_LEN, secret.length)
            .putString(K_TYPE, if (password) "password" else "pin")
            .putBoolean(K_ENABLED, true)
            .putInt(K_FAILS, 0)
            .putLong(K_LOCKED_UNTIL, 0L)
            .apply()
        markUnlocked()
    }

    fun disable(ctx: Context) {
        prefs(ctx).edit().clear().commit()
        markUnlocked()
    }

    /** Сколько ещё миллисекунд вход заблокирован после неверных попыток (0 — можно вводить). */
    fun lockRemainingMs(ctx: Context): Long =
        maxOf(0L, prefs(ctx).getLong(K_LOCKED_UNTIL, 0L) - System.currentTimeMillis())

    fun verifyPin(ctx: Context, pin: String): Boolean {
        if (lockRemainingMs(ctx) > 0) return false
        val p = prefs(ctx)
        val salt = Base64.decode(p.getString(K_SALT, "") ?: "", Base64.NO_WRAP)
        val expected = Base64.decode(p.getString(K_HASH, "") ?: "", Base64.NO_WRAP)
        val ok = salt.isNotEmpty() && MessageDigest.isEqual(hash(pin, salt), expected)
        if (ok) {
            p.edit().putInt(K_FAILS, 0).putLong(K_LOCKED_UNTIL, 0L).apply()
            return true
        }
        val fails = p.getInt(K_FAILS, 0) + 1
        val edit = p.edit().putInt(K_FAILS, fails)
        if (fails % 5 == 0) {
            // 5 неверных = 30 с, 10 = 60 с, 15 = 120 с ... но не дольше часа
            val steps = fails / 5
            val delay = minOf(30_000L * (1L shl minOf(steps - 1, 7)), 3_600_000L)
            edit.putLong(K_LOCKED_UNTIL, System.currentTimeMillis() + delay)
        }
        edit.apply()
        return false
    }

    /** «Забыли код»: выход из аккаунта и очистка локальных данных, затем перезапуск процесса. */
    fun wipeAndExit(ctx: Context) {
        val app = ctx.applicationContext
        disable(app)
        try {
            for (name in listOf("session.json", "session.key", "chats_cache.json", "messages_cache.json")) {
                File(app.filesDir, name).delete()
            }
        } catch (_: Exception) {
        }
        try {
            app.getSharedPreferences("pending_replies", Context.MODE_PRIVATE).edit().clear().commit()
        } catch (_: Exception) {
        }
        try {
            WebStorage.getInstance().deleteAllData()
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        } catch (_: Exception) {
        }
        try {
            File(app.applicationInfo.dataDir, "app_webview").deleteRecursively()
        } catch (_: Exception) {
        }
        android.os.Process.killProcess(android.os.Process.myPid())
    }
}
