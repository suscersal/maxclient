# MAX Client (Flask-версия)

[![Скачать APK (последний релиз)](https://img.shields.io/github/v/release/suscersal/maxclient?label=Download%20APK&logo=android&logoColor=white)](https://github.com/suscersal/maxclient/releases/latest/download/app-debug.apk)

## Кастомные боты

Клиент умеет подключать сторонних ботов, никак не связанных с протоколом MAX — им нужен только собственный веб-сервер (адрес + порт), отвечающий на два простых HTTP-эндпоинта. Переписка с таким ботом ведётся полностью локально (переписка хранится в `localStorage` браузера) и не проходит через основной MAX-аккаунт.

Управление ботами: **Настройки → 🤖 Кастомные боты**.

### Видимость в поиске

Добавленные кастомные боты видны в общем поиске по чатам (поле поиска над списком чатов), наравне с чатами и контактами MAX. Также поиск понимает `@username` и ссылки вида `https://max.ru/...` — такой запрос показывает пункт «Найти в MAX: …», который резолвит профиль/чат/бота напрямую через сервер.

Порядок выдачи в поиске (сверху — выше приоритет):

1. существующие чаты MAX (уже открытые диалоги/каналы);
2. контакты MAX, с которыми ещё нет диалога;
3. кастомные боты — сначала добавленные вручную, затем недавно «запускавшиеся» (открытые/использованные), затем остальные из реестра;
4. локальные контакты телефона;
5. подсказка «Найти в MAX: …» для `@username` / ссылок max.ru — резолвится на сервере, поэтому показывается последней.

### 1. Реестр ботов (GitHub)

Реестр — это обычный JSON-файл, который лежит в любом GitHub-репозитории и отдаётся через `raw.githubusercontent.com` (никакого отдельного бэкенда не нужно — хранилищем служит сам GitHub).

Формат `bots.json`:

```json
[
  {
    "name": "EchoBot",
    "url": "http://1.2.3.4:8080",
    "description": "Отвечает эхом на любое сообщение"
  },
  {
    "name": "WeatherBot",
    "url": "http://myhost.example.com:9090",
    "description": "Прогноз погоды по городу"
  }
]
```

Поля:

| Поле | Обязательно | Описание |
|---|---|---|
| `name` | да | Отображаемое имя бота |
| `url` | да | Базовый адрес сервера бота, **с портом** (`http://host:port`, без завершающего `/`) |
| `description` | нет | Короткое описание, показывается в списке реестра |

Как подключить свой реестр в клиенте:

1. Настройки → «Кастомные боты».
2. В поле «Raw-ссылка на bots.json» вставить ссылку вида
   `https://raw.githubusercontent.com/<пользователь>/<репозиторий>/<ветка>/bots.json`.
3. Нажать «⟳ Загрузить реестр» — появится список ботов с кнопкой «➕ Добавить».

Бота также можно добавить вручную (без реестра), указав только имя и `http://host:port` в форме «Добавить бота вручную».

### 2. API-контракт сервера бота

Сервер бота — это любой HTTP-сервер (Python/Node/Go/что угодно), который реализует два эндпоинта.

#### `GET {url}/api/info`

Необязательный, но рекомендуемый эндпоинт для отображения информации о боте.

Ответ `200 OK`:

```json
{
  "name": "MyBot",
  "description": "Что умеет бот",
  "avatar_url": "https://example.com/avatar.png",
  "version": "1.0"
}
```

#### `POST {url}/api/message`

Основной эндпоинт — клиент вызывает его при каждом сообщении пользователя.

**Тело запроса** (`Content-Type: application/json`):

```json
{
  "chat_id": "bot_a1b2c3d4",
  "user": { "id": 123456, "name": "Пользователь" },
  "text": "Привет!",
  "history": [
    { "role": "user", "text": "предыдущее сообщение", "ts": 1690000000000 },
    { "role": "bot",  "text": "предыдущий ответ бота", "ts": 1690000001000 }
  ]
}
```

- `chat_id` — локальный идентификатор чата с этим ботом в клиенте (стабилен для одной установки клиента).
- `user` — данные текущего пользователя клиента.
- `text` — текст только что отправленного сообщения.
- `history` — последние до 20 сообщений переписки (для контекста; можно игнорировать, если боту не нужна память).

**Ответ** (`200 OK`, `Content-Type: application/json`):

```json
{
  "text": "Привет! Чем могу помочь?\n\n```bash\necho hello\n```",
  "buttons": [
    [ { "text": "Кнопка 1", "value": "payload_1" } ]
  ]
}
```

- `text` — обязателен, текст ответа бота. Поддерживает блоки кода в формате ` ```язык ... ``` ` — они будут красиво отрисованы клиентом с кнопкой копирования.
- `buttons` — необязательно, зарезервировано под будущую поддержку инлайн-кнопок (сейчас клиент их не рендерит, но принимает без ошибок).

Любая ошибка сети или ответ не `200` отображается пользователю прямо в чате как системное сообщение вида «⚠️ Бот недоступен: …» — сам клиент не падает и не блокируется.

#### CORS (обязательно для локального теста в браузере)

Клиент — веб-страница, поэтому запросы к `{url}/api/message` идут прямо из браузера. Если сервер бота не пришлёт заголовки CORS, браузер заблокирует ответ с ошибкой вида:

```
Access to fetch at 'http://127.0.0.1:1904/api/message' from origin 'http://localhost:8080'
has been blocked by CORS policy: ...
```

Это правится **только на стороне сервера бота** — добавь CORS-заголовки:

```python
# Flask + flask-cors (pip install flask-cors)
from flask_cors import CORS
CORS(app)  # для локального теста достаточно разрешить все origin'ы
```

Без библиотеки — вручную:

```python
@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp
```

Node/Express — `app.use(require('cors')())`; FastAPI — `CORSMiddleware` с `allow_origins=["*"]`. Для продакшена вместо `"*"` лучше указать конкретный адрес клиента.

#### Минимальный пример сервера бота (Python/Flask)

```python
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # разрешает запросы из браузера (клиент открыт на другом origin)


@app.route("/api/info")
def info():
    return jsonify({
        "name": "EchoBot",
        "description": "Отвечает эхом на любое сообщение",
        "version": "1.0",
    })


@app.route("/api/message", methods=["POST"])
def message():
    data = request.get_json(force=True)
    text = data.get("text", "")

    if text == '/about':
        user_info = data.get('user', {})
        if isinstance(user_info, dict):
            user_name = user_info.get('name', 'Unknown')
            user_id = user_info.get('id', 'Unknown')
            output_text = f"Имя: {user_name}, ID: {user_id}"
        else:
            output_text = f"{user_info}"

        return jsonify({"text": output_text})
    else:
        return jsonify({
            "text": f"Эхо: {text}"
        })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=1904)

```

После запуска добавь бота в реестр (`bots.json`) или вручную в клиенте, указав `http://<твой-адрес>:8080`.