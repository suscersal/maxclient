package com.suscersal.maxclient

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.text.method.HideReturnsTransformationMethod
import android.text.method.PasswordTransformationMethod
import android.view.Gravity
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Установка или смена кода-пароля. Сначала выбор типа: PIN из цифр (4–8) или пароль
 * из любых символов (буквы, цифры, знаки). Дальше ввод и повтор.
 */
class PinSetupActivity : AppCompatActivity() {

    private lateinit var root: LinearLayout

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.gravity = Gravity.CENTER
        root.setBackgroundColor(0xFF16181D.toInt())
        root.setPadding(dp(16), dp(24), dp(16), dp(24))
        setContentView(root)
        showChooser()
    }

    // ---- общие элементы ----

    private fun titleView(text: String): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.textSize = 20f
        tv.setTextColor(Color.WHITE)
        tv.gravity = Gravity.CENTER
        tv.setPadding(0, 0, 0, dp(6))
        return tv
    }

    private fun statusView(): TextView {
        val tv = TextView(this)
        tv.textSize = 14f
        tv.setTextColor(0xFFFF6B6B.toInt())
        tv.gravity = Gravity.CENTER
        tv.minHeight = dp(24)
        tv.setPadding(0, 0, 0, dp(12))
        return tv
    }

    private fun linkView(text: String, onClick: () -> Unit): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.textSize = 15f
        tv.setTextColor(0xFF8774E1.toInt())
        tv.gravity = Gravity.CENTER
        tv.setPadding(dp(16), dp(18), dp(16), dp(8))
        tv.setOnClickListener { onClick() }
        return tv
    }

    private fun buttonView(text: String, filled: Boolean, onClick: () -> Unit): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.textSize = 16f
        tv.setTextColor(Color.WHITE)
        tv.gravity = Gravity.CENTER
        val bg = GradientDrawable()
        bg.cornerRadius = dp(14).toFloat()
        bg.setColor(if (filled) 0xFF8774E1.toInt() else 0x22FFFFFF)
        tv.background = bg
        tv.setPadding(dp(16), dp(14), dp(16), dp(14))
        tv.setOnClickListener { onClick() }
        return tv
    }

    private fun fieldView(hint: String): EditText {
        val et = EditText(this)
        et.hint = hint
        et.setHintTextColor(0x88FFFFFF.toInt())
        et.setTextColor(Color.WHITE)
        et.textSize = 18f
        val bg = GradientDrawable()
        bg.cornerRadius = dp(14).toFloat()
        bg.setColor(0x22FFFFFF)
        et.background = bg
        et.setPadding(dp(16), dp(12), dp(16), dp(12))
        et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        et.setSingleLine(true)
        return et
    }

    // ---- выбор типа ----

    private fun showChooser() {
        root.removeAllViews()
        root.addView(titleView("Тип код-пароля"))
        val lp = { top: Int ->
            LinearLayout.LayoutParams(dp(300), LinearLayout.LayoutParams.WRAP_CONTENT).also { it.topMargin = dp(top) }
        }
        root.addView(buttonView("PIN-код (цифры, 4–8)", true) { showPinFlow() }, lp(24))
        root.addView(buttonView("Пароль (буквы, цифры, любые символы)", false) { showPasswordFlow() }, lp(12))
        root.addView(linkView("Отмена") { finish() })
    }

    // ---- PIN ----

    private fun showPinFlow() {
        root.removeAllViews()
        var first: String? = null
        val title = titleView("Введите новый код-пароль")
        val status = statusView()
        val pad = PinPadView(this)
        pad.setLeftKey("✓")
        root.addView(title)
        root.addView(status)
        root.addView(pad)
        root.addView(linkView("Назад") { showChooser() })

        pad.onLeftKey = {
            val pin = pad.text()
            if (pin.length < AppLock.MIN_LEN) {
                status.text = "Минимум ${AppLock.MIN_LEN} цифры"
                pad.shake()
            } else {
                status.text = ""
                val f = first
                if (f == null) {
                    first = pin
                    title.text = "Повторите код-пароль"
                    pad.clear()
                } else if (f == pin) {
                    AppLock.setPin(this, pin)
                    setResult(RESULT_OK)
                    finish()
                } else {
                    first = null
                    status.text = "Коды не совпадают, попробуйте ещё раз"
                    title.text = "Введите новый код-пароль"
                    pad.shake()
                    pad.clear()
                }
            }
        }
    }

    // ---- пароль ----

    private fun showPasswordFlow() {
        root.removeAllViews()
        root.addView(titleView("Новый пароль"))
        val status = statusView()
        root.addView(status)

        val first = fieldView("Пароль")
        val second = fieldView("Повторите пароль")
        val lp = { top: Int ->
            LinearLayout.LayoutParams(dp(300), LinearLayout.LayoutParams.WRAP_CONTENT).also { it.topMargin = dp(top) }
        }
        root.addView(first, lp(0))
        root.addView(second, lp(12))

        var visible = false
        root.addView(linkView("Показать пароль") {
            visible = !visible
            val m = if (visible) HideReturnsTransformationMethod.getInstance() else PasswordTransformationMethod.getInstance()
            first.transformationMethod = m
            second.transformationMethod = m
        })

        root.addView(buttonView("Сохранить", true) {
            val a = first.text.toString()
            val b = second.text.toString()
            when {
                a.length < AppLock.MIN_PASSWORD ->
                    status.text = "Минимум ${AppLock.MIN_PASSWORD} символа"
                a.length > AppLock.MAX_PASSWORD ->
                    status.text = "Не длиннее ${AppLock.MAX_PASSWORD} символов"
                a != b ->
                    status.text = "Пароли не совпадают"
                else -> {
                    AppLock.setPassword(this, a)
                    setResult(RESULT_OK)
                    finish()
                }
            }
        }, lp(8))
        root.addView(linkView("Назад") { showChooser() })
    }
}
