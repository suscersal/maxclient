package com.example.maxclient

import android.content.Context
import android.graphics.Canvas
import android.graphics.Movie
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View

/**
 * Простейший проигрыватель GIF без WebView и сторонних библиотек.
 *
 * Почему не WebView: голая навигация WebView на file:///android_asset/x.gif
 * ненадёжна (иногда рендерится просто как статичная заглушка вместо
 * анимации), а обёртка в мини-HTML тоже иногда не помогает в зависимости
 * от версии системного WebView на устройстве. android.graphics.Movie
 * рисует кадры GIF сам, без WebView вообще, поэтому не зависит от его
 * поведения.
 *
 * Movie помечен @Deprecated начиная с API 28, но не удалён и продолжает
 * работать на всех текущих версиях Android (minSdk этого проекта — 24).
 */
class GifView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private var movie: Movie? = null
    private var movieStart: Long = 0L

    /** assetPath — путь внутри assets, например "loading.gif". */
    fun setGifFromAssets(assetPath: String) {
        try {
            context.assets.open(assetPath).use { input ->
                movie = Movie.decodeStream(input)
            }
        } catch (e: Exception) {
            movie = null
        }
        movieStart = 0L
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val m = movie ?: return
        val duration = m.duration().takeIf { it > 0 } ?: 1000

        val now = SystemClock.uptimeMillis()
        if (movieStart == 0L) movieStart = now
        val relTime = ((now - movieStart) % duration).toInt()
        m.setTime(relTime)

        if (width > 0 && height > 0 && m.width() > 0 && m.height() > 0) {
            val scaleX = width.toFloat() / m.width()
            val scaleY = height.toFloat() / m.height()
            canvas.save()
            canvas.scale(scaleX, scaleY)
            m.draw(canvas, 0f, 0f)
            canvas.restore()
        }

        // Гоняем перерисовку сами — это и есть анимация.
        invalidate()
    }
}