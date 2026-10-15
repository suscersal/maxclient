# Интерфейс /tg/ (Web K): как он собран

Источник правды — готовые файлы в `static/tg/` (воркеры правятся на месте). Скрипты ниже идемпотентны
и запускаются из корня репо:

- `python3 scripts/tg/patch_ext2.py` — поиск (контакты/сообщения/телефон/публичные чаты), пресенс,
  каналы без отправителя, фикс аватарок (код — `ext2.js`);
- `python3 scripts/tg/patch_ext3.py` — вложения в ленте (фото/файлы/видео/голосовые/стикеры → `upload.getFile` через `/img` и `/video`),
  закрепление чатов (opcode 274) и сообщений (opcode 55), отправка фото/файлов (`/api/upload-*` + opcode 64). Запускать после ext2 (код — `ext3.js`);
- `python3 scripts/tg/patch_ru.py` — русский язык (`ru.json` → `lang-*.js`, langPackCode=ru).

Пункты старого меню добавляет скрипт `#mx-menu` в `static/tg/index.html` (открывает `/?ui=classic&open=<id>` во
встроенном окне; на стороне старого интерфейса это обрабатывает `#mx-embed-open` в `static/index.html`).
`adapter.js`/`patch_tg.py` — первая версия адаптера (до аккаунтов и аватарок), оставлены для истории.

- ext3 также: Premium бесплатно (self.pFlags.premium, `premium_purchase_blocked`), расшифровка голосовых/кружков через `/api/transcribe/max-native` (opcode 202).
- ext3: реальное число участников (opcode 48) в списке чатов и в `messages.getFullChat` (раньше жёстко «3»).

- Воркеры в `static/tg/` коммитятся уже пропатченными (готовые воркеры): `patch_ext3.py` нужен только разработчику при правке `ext3.js`.

- Доставка на Android: воркеры `static/tg/index.worker-*.js` едут через OTA/hotpatch (`generate-ota-manifest.sh`, оверлей `tg/` в `bridge.py`), поэтому их изменение НЕ запускает сборку APK. Любой другой файл в `static/tg/` (index.html, чанки) по-прежнему требует полной сборки.
