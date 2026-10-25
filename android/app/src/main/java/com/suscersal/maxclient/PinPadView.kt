package com.suscersal.maxclient

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.animation.Animation
import android.view.animation.TranslateAnimation
import android.widget.LinearLayout
import android.widget.TextView

/** Цифровая клавиатура с точками, общая для экрана блокировки и экрана установки кода. */
class PinPadView(context: Context) : LinearLayout(context) {

    /** >0 — отправлять автоматически, когда введено столько цифр (экран блокировки). */
    var autoLen = 0
        set(value) {
            field = value
            renderDots()
        }

    var onSubmit: ((String) -> Unit)? = null
    var onLeftKey: (() -> Unit)? = null

    private val sb = StringBuilder()
    private val dotsRow = LinearLayout(context)
    private val allKeys = ArrayList<TextView>()
    private lateinit var leftKey: TextView

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL

        dotsRow.orientation = HORIZONTAL
        dotsRow.gravity = Gravity.CENTER
        addView(dotsRow, LayoutParams(LayoutParams.WRAP_CONTENT, dp(28)).also { it.bottomMargin = dp(24) })

        val rows = arrayOf(arrayOf("1", "2", "3"), arrayOf("4", "5", "6"), arrayOf("7", "8", "9"), arrayOf("", "0", "⌫"))
        for (r in rows) {
            val row = LinearLayout(context)
            row.orientation = HORIZONTAL
            for (label in r) {
                val key = makeKey(label)
                if (r === rows[3] && label == "") {
                    leftKey = key
                    key.visibility = View.INVISIBLE
                }
                row.addView(key)
            }
            addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        }
        renderDots()
    }

    private fun makeKey(label: String): TextView {
        val tv = TextView(context)
        tv.text = label
        tv.textSize = 26f
        tv.setTextColor(Color.WHITE)
        tv.gravity = Gravity.CENTER
        val bg = GradientDrawable()
        bg.shape = GradientDrawable.OVAL
        bg.setColor(0x22FFFFFF)
        tv.background = bg
        val lp = LayoutParams(dp(76), dp(76))
        lp.setMargins(dp(10), dp(8), dp(10), dp(8))
        tv.layoutParams = lp
        allKeys.add(tv)
        tv.setOnClickListener {
            when (label) {
                "" -> onLeftKey?.invoke()
                "⌫" -> {
                    if (sb.isNotEmpty()) sb.deleteCharAt(sb.length - 1)
                    renderDots()
                }
                else -> addDigit(label)
            }
        }
        return tv
    }

    private fun addDigit(d: String) {
        if (sb.length >= AppLock.MAX_LEN) return
        sb.append(d)
        renderDots()
        if (autoLen > 0 && sb.length == autoLen) {
            val v = sb.toString()
            onSubmit?.invoke(v)
        }
    }

    /** Нижняя левая клавиша: «👆» для отпечатка, «✓» для подтверждения; null — скрыть. */
    fun setLeftKey(label: String?) {
        if (label == null) {
            leftKey.visibility = View.INVISIBLE
        } else {
            leftKey.text = label
            leftKey.visibility = View.VISIBLE
        }
    }

    fun text(): String = sb.toString()

    fun clear() {
        sb.setLength(0)
        renderDots()
    }

    fun setKeysEnabled(enabled: Boolean) {
        for (k in allKeys) {
            k.isEnabled = enabled
            k.alpha = if (enabled) 1f else 0.35f
        }
    }

    fun shake() {
        val a = TranslateAnimation(-dp(12).toFloat(), dp(12).toFloat(), 0f, 0f)
        a.duration = 60
        a.repeatCount = 5
        a.repeatMode = Animation.REVERSE
        dotsRow.startAnimation(a)
    }

    private fun renderDots() {
        dotsRow.removeAllViews()
        val count = if (autoLen > 0) autoLen else maxOf(AppLock.MIN_LEN, sb.length)
        for (i in 0 until count) {
            val dot = View(context)
            val d = GradientDrawable()
            d.shape = GradientDrawable.OVAL
            if (i < sb.length) {
                d.setColor(Color.WHITE)
            } else {
                d.setColor(Color.TRANSPARENT)
                d.setStroke(dp(2), 0x88FFFFFF.toInt())
            }
            dot.background = d
            val lp = LayoutParams(dp(14), dp(14))
            lp.setMargins(dp(8), 0, dp(8), 0)
            dotsRow.addView(dot, lp)
        }
    }
}
