package com.suscersal.maxclient

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Очередь ответов из уведомлений. Ответ записывается на диск ДО отправки и удаляется
 * только после того, как MAX принял сообщение — если процесс убили или сети не было,
 * ответ уйдёт при следующем запуске приложения (flush из MainActivity) или при
 * следующем успешном ответе. Ответы старше суток не отправляются.
 */
object PendingReplies {
    private const val PREFS = "pending_replies"
    private const val KEY = "items"
    private const val MAX_AGE_MS = 24L * 3600 * 1000
    private val inFlight = HashSet<Long>()

    private fun load(ctx: Context): JSONArray =
        try {
            JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "[]"))
        } catch (_: Exception) {
            JSONArray()
        }

    private fun save(ctx: Context, arr: JSONArray) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, arr.toString()).apply()
    }

    /** Записывает ответ в очередь и помечает «в работе» (его отправит вызвавший). */
    @Synchronized
    fun add(ctx: Context, chatId: Long, text: String): Long {
        var id = System.currentTimeMillis()
        while (inFlight.contains(id)) id++
        val arr = load(ctx)
        arr.put(JSONObject().put("id", id).put("chatId", chatId).put("text", text))
        save(ctx, arr)
        inFlight.add(id)
        return id
    }

    @Synchronized
    private fun remove(ctx: Context, id: Long) {
        val arr = load(ctx)
        val rest = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getLong("id") != id) rest.put(o)
        }
        save(ctx, rest)
    }

    @Synchronized
    fun release(id: Long) {
        inFlight.remove(id)
    }

    /** Повторно занять элемент перед второй попыткой; false — его уже отправляет кто-то другой. */
    @Synchronized
    fun reserve(id: Long): Boolean = inFlight.add(id)

    /** Отправка одного элемента очереди (сервер уже должен быть поднят). */
    fun trySend(ctx: Context, id: Long, chatId: Long, text: String): Boolean {
        return try {
            val ok = BridgeStarter.postReply(chatId, text)
            if (ok) remove(ctx, id)
            ok
        } finally {
            release(id)
        }
    }

    /** Досылает всё, что осталось в очереди и сейчас никем не отправляется. */
    fun flush(ctx: Context) {
        val todo = ArrayList<JSONObject>()
        synchronized(this) {
            val arr = load(ctx)
            val fresh = JSONArray()
            val now = System.currentTimeMillis()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (now - o.getLong("id") > MAX_AGE_MS) continue
                fresh.put(o)
                if (inFlight.add(o.getLong("id"))) todo.add(o)
            }
            save(ctx, fresh)
        }
        for (o in todo) {
            if (!trySend(ctx, o.getLong("id"), o.getLong("chatId"), o.getString("text"))) break
        }
        // то, что не отправили из-за break, вернуть в «не в работе»
        for (o in todo) release(o.getLong("id"))
    }
}
