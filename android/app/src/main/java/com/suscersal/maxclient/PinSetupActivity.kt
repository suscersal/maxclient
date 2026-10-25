package com.suscersal.maxclient

import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** Установка или смена кода-пароля: ввести 4–8 цифр, нажать ✓, повторить. */
class PinSetupActivity : AppCompatActivity() {

    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var pad: PinPadView
    private var first: String? = null

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.gravity = Gravity.CENTER
        root.setBackgroundColor(0xFF16181D.toInt())
        root.setPadding(dp(16), dp(24), dp(16), dp(24))

        title = TextView(this)
        title.textSize = 20f
        title.setTextColor(Color.WHITE)
        title.gravity = Gravity.CENTER
        title.setPadding(0, 0, 0, dp(6))
        root.addView(title)

        status = TextView(this)
        status.textSize = 14f
        status.setTextColor(0xFFFF6B6B.toInt())
        status.gravity = Gravity.CENTER
        status.minHeight = dp(24)
        status.setPadding(0, 0, 0, dp(16))
        root.addView(status)

        pad = PinPadView(this)
        pad.setLeftKey("✓")
        pad.onLeftKey = { submit() }
        root.addView(pad)

        val cancel = TextView(this)
        cancel.text = "Отмена"
        cancel.textSize = 15f
        cancel.setTextColor(0xFF8774E1.toInt())
        cancel.gravity = Gravity.CENTER
        cancel.setPadding(dp(16), dp(20), dp(16), dp(8))
        cancel.setOnClickListener { finish() }
        root.addView(cancel)

        setContentView(root)
        renderStep()
    }

    private fun renderStep() {
        title.text = if (first == null) "Введите новый код-пароль" else "Повторите код-пароль"
        pad.clear()
    }

    private fun submit() {
        val pin = pad.text()
        if (pin.length < AppLock.MIN_LEN) {
            status.text = "Минимум ${AppLock.MIN_LEN} цифры"
            pad.shake()
            return
        }
        status.text = ""
        val f = first
        if (f == null) {
            first = pin
            renderStep()
            return
        }
        if (f == pin) {
            AppLock.setPin(this, pin)
            setResult(RESULT_OK)
            finish()
        } else {
            first = null
            status.text = "Коды не совпадают, попробуйте ещё раз"
            pad.shake()
            renderStep()
        }
    }
}
