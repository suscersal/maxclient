from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # разрешает запросы из браузера (клиент открыт на другом origin)

name = "EchoBot"
description = "Отвечает эхом на любое сообщение. Поддерживает *разметку*, кнопки и меню."

# Аватарка бота — показывается в шапке чата и в списке ботов.
# Можно указать любую прямую ссылку на картинку; если бот недоступен
# или поле не задано — клиент покажет эмодзи-заглушку 🤖.
avatar_url = "https://api.dicebear.com/7.x/bottts/svg?seed=EchoBot"

# Команды бота — используются клиентом для кнопки-меню (аналог кнопки
# "меню" внизу чата в Telegram): список показывается пользователю, клик по
# пункту отправляет команду как обычное сообщение.
commands = {
    "/info": "информация о боте",
    "/about": "информация о пользователе",
    "/keyboard": "показать/скрыть постоянную клавиатуру",
    "/start": "старт"
}

# Инлайн-кнопки под сообщением (аналог inline-клавиатуры в Telegram).
# Формат: список РЯДОВ, каждый ряд — список кнопок.
# {"text":..., "value":...} — клик отправляет value как сообщение.
# {"text":..., "url":...}   — клик просто открывает ссылку, ничего не отправляет.
MAIN_MENU_BUTTONS = [
    [{"text": "ℹ️ О боте", "value": "/info"}],
    [{"text": "👤 О пользователе", "value": "/about"}],
    [{"text": "🌐 Исходники (GitHub)", "url": "https://github.com"}],
]

# Постоянная reply-клавиатура (не inline) — держится над полем ввода,
# пока бот не пришлёт новую или не уберёт (remove_keyboard: true).
REPLY_KEYBOARD = [
    [{"text": "😀", "value": "/echo 😀"}, {"text": "👍",
                                         "value": "/echo 👍"}, {"text": "🔥", "value": "/echo 🔥"}],
    [{"text": "ℹ️ Инфо", "value": "/info"}],
]


@app.route("/api/info")
def info():
    return jsonify({
        "name": name,
        "description": description,
        "commands": commands,
        "avatar_url": avatar_url,
    })


@app.route("/api/message", methods=["POST"])
def message():
    data = request.get_json(force=True)
    text = (data.get("text", "") or "").strip()

    if text in ("/start", "/menu"):
        return jsonify({
            "text": f"👋 Привет! Я **{name}**. {description}\n\n"
            f"Выберите пункт меню или просто напишите мне что-нибудь — я отвечу эхом.",
            "buttons": MAIN_MENU_BUTTONS,
            "keyboard": REPLY_KEYBOARD,
        })

    elif text == "/about":
        user_info = data.get("user", {})
        if isinstance(user_info, dict):
            user_name = user_info.get("name", "Unknown")
            user_id = user_info.get("id", "Unknown")
            output_text = f"Имя: **{user_name}**, ID: `{user_id}`"
        else:
            output_text = f"{user_info}"

        return jsonify({
            "text": output_text,
            "buttons": MAIN_MENU_BUTTONS,
        })

    elif text == "/info":
        commands_text = "\n".join(
            f"`{cmd}` — {desc}" for cmd, desc in commands.items())
        return jsonify({
            "text": f"Имя: **{name}**. Описание: {description}\n\nКоманды:\n{commands_text}",
            "buttons": MAIN_MENU_BUTTONS,
        })

    elif text == "/keyboard":
        # Убираем постоянную клавиатуру нажатием той же команды повторно —
        # простой пример remove_keyboard.
        return jsonify({
            "text": "Клавиатура снята. Наберите /start, чтобы вернуть её обратно.",
            "remove_keyboard": True,
        })

    else:
        return jsonify({
            "text": f"Эхо: *{text}*",
            "buttons": MAIN_MENU_BUTTONS,
        })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=1904)
