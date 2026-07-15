# MAX Client (неофициальный, самопальный)

## Что изменилось

Раньше бэкенд ходил в веб-версию (`wss://ws-api.oneme.ru/websocket`), у которой
жёсткий антибот с капчей VK ID (`not_robot_captcha`).

Теперь бэкенд говорит напрямую с "родным" бинарным протоколом MAX
(`api.oneme.ru:443`, сырой TLS-сокет + 10-байтный заголовок + MessagePack/LZ4) —
тем же самым, что использует настоящее мобильное приложение. Формат портирован
из открытого клиента Komet (lib/utils/packet_framer.dart, lib/api/api_service*.dart).
Судя по исходникам Komet, капча в этом протоколе не встречается — только
спуфинг userAgent под настоящий Android (см. build_user_agent() в bridge.py).

## Установка (Termux)

```bash
unzip maxclient.zip
cd maxclient
pip install aiohttp msgpack lz4 --break-system-packages
python bridge.py
```

Открой в Chrome на телефоне: http://localhost:8080
Через меню браузера → «Добавить на главный экран» — получится PWA.

## Как дособрать протокол дальше

Опкоды, которые уже есть (взяты из Komet):
- 6 — SESSION_INIT (handshake, шлётся автоматически при connect)
- 17 — AUTH_REQUEST (запрос кода: `{phone, type: "START_AUTH"|"RESEND"}`)
- 18 — CHECK_CODE (проверка кода: `{token, verifyCode, authTokenType: "CHECK_CODE"}`)
- 19 — ChatSyncRequest (список чатов)
- 23 — завершение регистрации
- 96/97 — список/завершение сессий
- 115/116 — пароль аккаунта
- 1 — ping (`{interactive: true}`, раз в 25 сек)

Остальные опкоды (отправка сообщения, входящие пуш-события, звонки) есть в
других файлах Komet — `api_service_chats.dart`, `message_handler.dart` и т.п.
Смотри их и добавляй методы в `bridge.py`/`index.html` по аналогии с `requestOtp`/`verifyCode`.

## Важно

MAX активно блокирует неофициальные клиенты на своей стороне. Аккаунт или
сессия могут быть отключены. Используй на свой риск, желательно не на
основном номере.
