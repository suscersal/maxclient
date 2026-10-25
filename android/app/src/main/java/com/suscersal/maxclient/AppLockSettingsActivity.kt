package com.suscersal.maxclient

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/** Настройки «Код-пароль» в стиле Telegram. Открываются из меню настроек или по долгому тапу на иконку приложения. */
class AppLockSettingsActivity : AppCompatActivity() {

    private lateinit var content: LinearLayout
    private lateinit var scroll: ScrollView

    private val bio = BiometricManager.Authenticators.BIOMETRIC_STRONG or
        BiometricManager.Authenticators.BIOMETRIC_WEAK

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        scroll = ScrollView(this)
        scroll.setBackgroundColor(0xFF16181D.toInt())
        content = LinearLayout(this)
        content.orientation = LinearLayout.VERTICAL
        scroll.addView(content)
        setContentView(scroll)
    }

    override fun onStart() {
        super.onStart()
        // Открыли настройки, когда приложение заблокировано (например, ярлык с иконки) — сначала код.
        if (AppLock.shouldLock(this)) {
            scroll.visibility = View.INVISIBLE
            if (!LockActivity.isShowing) startActivity(Intent(this, LockActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        if (!AppLock.shouldLock(this)) {
            scroll.visibility = View.VISIBLE
            render()
        }
    }

    private fun biometricSupported(): Boolean =
        BiometricManager.from(this).canAuthenticate(bio) == BiometricManager.BIOMETRIC_SUCCESS

    private fun render() {
        content.removeAllViews()
        val enabled = AppLock.isEnabled(this)

        content.addView(header("Код-пароль"))

        content.addView(switchRow("Код-пароль", "Запрашивать код при входе в приложение", enabled) { on ->
            if (on) {
                startActivityForResult(Intent(this, PinSetupActivity::class.java), 1)
            } else {
                AlertDialog.Builder(this)
                    .setTitle("Отключить код-пароль?")
                    .setPositiveButton("Отключить") { _, _ ->
                        AppLock.disable(this)
                        render()
                    }
                    .setNegativeButton("Отмена") { _, _ -> render() }
                    .setOnCancelListener { render() }
                    .show()
            }
        })

        if (enabled) {
            content.addView(clickRow("Изменить код-пароль", null) {
                startActivityForResult(Intent(this, PinSetupActivity::class.java), 1)
            })

            val t = AppLock.timeoutMs(this)
            val idx = AppLock.TIMEOUT_VALUES.indexOf(t).let { if (it < 0) 1 else it }
            content.addView(clickRow("Автоблокировка", AppLock.TIMEOUT_LABELS[idx]) {
                AlertDialog.Builder(this)
                    .setTitle("Автоблокировка")
                    .setSingleChoiceItems(AppLock.TIMEOUT_LABELS, idx) { d, which ->
                        AppLock.setTimeoutMs(this, AppLock.TIMEOUT_VALUES[which])
                        d.dismiss()
                        render()
                    }
                    .setNegativeButton("Отмена", null)
                    .show()
            })

            if (biometricSupported()) {
                content.addView(switchRow("Разблокировка отпечатком", "Или распознаванием лица", AppLock.biometricEnabled(this)) { on ->
                    if (on) confirmBiometric() else {
                        AppLock.setBiometricEnabled(this, false)
                        render()
                    }
                })
            }

            content.addView(switchRow(
                "Показывать текст сообщений",
                "В уведомлениях. Выключено — только «Новое сообщение»",
                AppLock.showPreview(this)
            ) { on ->
                AppLock.setShowPreview(this, on)
                render()
            })
        }

        content.addView(note(
            if (enabled)
                "Автоблокировка «Только при запуске» запрашивает код после полного закрытия приложения. " +
                    "Остальные значения блокируют приложение, если вы вне его дольше выбранного времени."
            else
                "Когда включено, при входе в приложение нужно ввести код (или приложить палец). " +
                    "Текст сообщений в уведомлениях при этом скрывается."
        ))
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        render()
    }

    private fun confirmBiometric() {
        val executor = ContextCompat.getMainExecutor(this)
        val prompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                AppLock.setBiometricEnabled(this@AppLockSettingsActivity, true)
                render()
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                render()
            }
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Разблокировка отпечатком")
            .setSubtitle("Подтвердите, чтобы включить")
            .setNegativeButtonText("Отмена")
            .setAllowedAuthenticators(bio)
            .build()
        prompt.authenticate(info)
    }

    // ---- мелкие строители UI ----

    private fun header(text: String): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.textSize = 22f
        tv.setTextColor(Color.WHITE)
        tv.setPadding(dp(20), dp(28), dp(20), dp(16))
        return tv
    }

    private fun rowBase(title: String, subtitle: String?): Pair<LinearLayout, LinearLayout> {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(20), dp(14), dp(20), dp(14))
        val texts = LinearLayout(this)
        texts.orientation = LinearLayout.VERTICAL
        val t = TextView(this)
        t.text = title
        t.textSize = 16f
        t.setTextColor(Color.WHITE)
        texts.addView(t)
        if (subtitle != null) {
            val s = TextView(this)
            s.text = subtitle
            s.textSize = 13f
            s.setTextColor(0xFF9AA0A8.toInt())
            texts.addView(s)
        }
        row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        return Pair(row, texts)
    }

    private fun clickRow(title: String, subtitle: String?, onClick: () -> Unit): View {
        val (row, _) = rowBase(title, subtitle)
        row.isClickable = true
        row.setOnClickListener { onClick() }
        return row
    }

    private fun switchRow(title: String, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit): View {
        val (row, _) = rowBase(title, subtitle)
        val sw = SwitchCompat(this)
        sw.isChecked = checked
        // OnClickListener (а не OnCheckedChange): срабатывает и на тап по переключателю, и на тап по строке,
        // но не срабатывает при программной перерисовке экрана.
        sw.setOnClickListener { onChange(sw.isChecked) }
        row.addView(sw)
        row.setOnClickListener { sw.performClick() }
        return row
    }

    private fun note(text: String): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.textSize = 13f
        tv.setTextColor(0xFF9AA0A8.toInt())
        tv.setPadding(dp(20), dp(16), dp(20), dp(28))
        return tv
    }
}
