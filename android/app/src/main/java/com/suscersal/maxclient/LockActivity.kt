package com.suscersal.maxclient

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.CountDownTimer
import android.text.InputType
import android.text.method.HideReturnsTransformationMethod
import android.text.method.PasswordTransformationMethod
import android.view.Gravity
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/** Экран ввода кода-пароля (PIN или пароль). Скриншоты и превью в «недавних» тут запрещены (FLAG_SECURE). */
class LockActivity : AppCompatActivity() {

    companion object {
        @Volatile
        var isShowing = false
        private const val BIO = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.BIOMETRIC_WEAK
    }

    private var pad: PinPadView? = null
    private var field: EditText? = null
    private var submitBtn: TextView? = null
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

        val password = AppLock.isPassword(this)
        val title = TextView(this)
        title.text = if (password) "Введите пароль" else "Введите код-пароль"
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

        if (password) buildPasswordInput(root) else buildPinPad(root)

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

    private fun buildPinPad(root: LinearLayout) {
        val p = PinPadView(this)
        p.autoLen = AppLock.pinLength(this)
        p.onSubmit = { pin -> checkSecret(pin) }
        p.onLeftKey = { if (biometricAvailable()) showBiometric() }
        p.setLeftKey(if (biometricAvailable()) "👆" else null)
        pad = p
        root.addView(p)
    }

    private fun buildPasswordInput(root: LinearLayout) {
        val box = LinearLayout(this)
        box.orientation = LinearLayout.HORIZONTAL
        box.gravity = Gravity.CENTER_VERTICAL
        val bg = GradientDrawable()
        bg.cornerRadius = dp(14).toFloat()
        bg.setColor(0x22FFFFFF)
        box.background = bg
        box.setPadding(dp(16), dp(4), dp(8), dp(4))

        val et = EditText(this)
        et.hint = "Пароль"
        et.setHintTextColor(0x88FFFFFF.toInt())
        et.setTextColor(Color.WHITE)
        et.textSize = 18f
        et.setBackgroundColor(Color.TRANSPARENT)
        et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        et.imeOptions = EditorInfo.IME_ACTION_DONE
        et.setSingleLine(true)
        et.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                checkSecret(et.text.toString())
                true
            } else {
                false
            }
        }
        field = et
        box.addView(et, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val eye = TextView(this)
        eye.text = "👁"
        eye.textSize = 20f
        eye.setPadding(dp(10), dp(8), dp(10), dp(8))
        var visible = false
        eye.setOnClickListener {
            visible = !visible
            et.transformationMethod =
                if (visible) HideReturnsTransformationMethod.getInstance() else PasswordTransformationMethod.getInstance()
            et.setSelection(et.text.length)
        }
        box.addView(eye)
        root.addView(box, LinearLayout.LayoutParams(dp(300), LinearLayout.LayoutParams.WRAP_CONTENT))

        val btn = TextView(this)
        btn.text = "Разблокировать"
        btn.textSize = 16f
        btn.setTextColor(Color.WHITE)
        btn.gravity = Gravity.CENTER
        val btnBg = GradientDrawable()
        btnBg.cornerRadius = dp(14).toFloat()
        btnBg.setColor(0xFF8774E1.toInt())
        btn.background = btnBg
        btn.setPadding(dp(16), dp(14), dp(16), dp(14))
        btn.setOnClickListener { checkSecret(et.text.toString()) }
        submitBtn = btn
        val lp = LinearLayout.LayoutParams(dp(300), LinearLayout.LayoutParams.WRAP_CONTENT)
        lp.topMargin = dp(16)
        root.addView(btn, lp)

        if (biometricAvailable()) {
            val bio = TextView(this)
            bio.text = "👆 Отпечаток"
            bio.textSize = 15f
            bio.setTextColor(0xFF8774E1.toInt())
            bio.gravity = Gravity.CENTER
            bio.setPadding(dp(16), dp(14), dp(16), dp(4))
            bio.setOnClickListener { showBiometric() }
            root.addView(bio)
        }
    }

    override fun onResume() {
        super.onResume()
        isShowing = true
        refreshLockout()
        if (!bioAutoShown && biometricAvailable() && AppLock.lockRemainingMs(this) == 0L) {
            bioAutoShown = true
            showBiometric()
        } else {
            field?.let {
                it.requestFocus()
                (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(it, 0)
            }
        }
    }

    override fun onPause() {
        super.onPause()
        isShowing = false
        timer?.cancel()
    }

    private fun checkSecret(secret: String) {
        if (secret.isEmpty()) return
        if (AppLock.verifyPin(this, secret)) {
            unlockNow()
            return
        }
        pad?.shake()
        pad?.clear()
        field?.text?.clear()
        if (AppLock.lockRemainingMs(this) > 0) {
            refreshLockout()
        } else {
            status.text = if (AppLock.isPassword(this)) "Неверный пароль" else "Неверный код-пароль"
        }
    }

    private fun setInputEnabled(enabled: Boolean) {
        pad?.setKeysEnabled(enabled)
        field?.isEnabled = enabled
        submitBtn?.isEnabled = enabled
        submitBtn?.alpha = if (enabled) 1f else 0.35f
    }

    private fun refreshLockout() {
        timer?.cancel()
        val remaining = AppLock.lockRemainingMs(this)
        if (remaining <= 0) {
            setInputEnabled(true)
            return
        }
        setInputEnabled(false)
        timer = object : CountDownTimer(remaining, 500) {
            override fun onTick(ms: Long) {
                status.text = "Слишком много попыток. Повторите через ${(ms + 999) / 1000} с"
            }

            override fun onFinish() {
                status.text = ""
                setInputEnabled(true)
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
            .setNegativeButtonText(if (AppLock.isPassword(this)) "Ввести пароль" else "Ввести код")
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
