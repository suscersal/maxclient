package com.suscersal.maxclient

import android.graphics.Color
import android.os.Bundle
import android.os.CountDownTimer
import android.view.Gravity
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/** Экран ввода кода-пароля. Скриншоты и превью в «недавних» тут запрещены (FLAG_SECURE). */
class LockActivity : AppCompatActivity() {

    companion object {
        @Volatile
        var isShowing = false
        private const val BIO = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.BIOMETRIC_WEAK
    }

    private lateinit var pad: PinPadView
    private lateinit var status: TextView
    private var timer: CountDownTimer? = null
    private var bioAutoShown = false

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.gravity = Gravity.CENTER
        root.setBackgroundColor(0xFF16181D.toInt())
        root.setPadding(dp(16), dp(24), dp(16), dp(24))

        val icon = TextView(this)
        icon.text = "🔒"
        icon.textSize = 44f
        icon.gravity = Gravity.CENTER
        root.addView(icon)

        val title = TextView(this)
        title.text = "Введите код-пароль"
        title.textSize = 20f
        title.setTextColor(Color.WHITE)
        title.gravity = Gravity.CENTER
        title.setPadding(0, dp(12), 0, dp(6))
        root.addView(title)

        status = TextView(this)
        status.textSize = 14f
        status.setTextColor(0xFFFF6B6B.toInt())
        status.gravity = Gravity.CENTER
        status.minHeight = dp(24)
        status.setPadding(0, 0, 0, dp(16))
        root.addView(status)

        pad = PinPadView(this)
        pad.autoLen = AppLock.pinLength(this)
        pad.onSubmit = { pin -> checkPin(pin) }
        pad.onLeftKey = { if (biometricAvailable()) showBiometric() }
        pad.setLeftKey(if (biometricAvailable()) "👆" else null)
        root.addView(pad)

        val forgot = TextView(this)
        forgot.text = "Забыли код-пароль?"
        forgot.textSize = 14f
        forgot.setTextColor(0xFF8774E1.toInt())
        forgot.gravity = Gravity.CENTER
        forgot.setPadding(dp(16), dp(20), dp(16), dp(8))
        forgot.setOnClickListener { confirmReset() }
        root.addView(forgot)

        setContentView(root)

        // «Назад» не должно открывать приложение мимо блокировки — сворачиваем.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })
    }

    override fun onResume() {
        super.onResume()
        isShowing = true
        refreshLockout()
        if (!bioAutoShown && biometricAvailable() && AppLock.lockRemainingMs(this) == 0L) {
            bioAutoShown = true
            showBiometric()
        }
    }

    override fun onPause() {
        super.onPause()
        isShowing = false
        timer?.cancel()
    }

    private fun checkPin(pin: String) {
        if (AppLock.verifyPin(this, pin)) {
            unlockNow()
            return
        }
        pad.shake()
        pad.clear()
        if (AppLock.lockRemainingMs(this) > 0) {
            refreshLockout()
        } else {
            status.text = "Неверный код-пароль"
        }
    }

    private fun refreshLockout() {
        timer?.cancel()
        val remaining = AppLock.lockRemainingMs(this)
        if (remaining <= 0) {
            pad.setKeysEnabled(true)
            return
        }
        pad.setKeysEnabled(false)
        timer = object : CountDownTimer(remaining, 500) {
            override fun onTick(ms: Long) {
                status.text = "Слишком много попыток. Повторите через ${(ms + 999) / 1000} с"
            }

            override fun onFinish() {
                status.text = ""
                pad.setKeysEnabled(true)
            }
        }.start()
    }

    private fun unlockNow() {
        AppLock.markUnlocked()
        isShowing = false
        finish()
    }

    private fun biometricAvailable(): Boolean =
        AppLock.biometricEnabled(this) &&
            BiometricManager.from(this).canAuthenticate(BIO) == BiometricManager.BIOMETRIC_SUCCESS

    private fun showBiometric() {
        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                unlockNow()
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Разблокировка")
            .setSubtitle("Приложите палец или используйте распознавание лица")
            .setNegativeButtonText("Ввести код")
            .setAllowedAuthenticators(BIO)
            .build()
        prompt.authenticate(info)
    }

    private fun confirmReset() {
        AlertDialog.Builder(this)
            .setTitle("Сбросить приложение?")
            .setMessage("Вы выйдете из аккаунта, а локальные данные приложения будут удалены. Затем потребуется войти заново.")
            .setPositiveButton("Выйти и удалить") { _, _ -> AppLock.wipeAndExit(this) }
            .setNegativeButton("Отмена", null)
            .show()
    }
}
