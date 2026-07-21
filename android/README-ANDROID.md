# MAX Client — Android (единый APK)

Архитектура: Flask-сервер (`bridge.py`) выполняется прямо внутри
приложения через **Chaquopy** (встроенный CPython в APK) и слушает
`127.0.0.1:8080`. `MainActivity` запускает его в фоновом потоке и
открывает WebView на этот адрес — снаружи, для пользователя, это
одно обычное Android-приложение, без внешнего сервера.

## Что нужно сделать перед первой сборкой

1. **Положите свой `bridge.py`** (без изменений) в:
   ```
   app/src/main/python/bridge.py
   ```
   и удалите файл-заглушку `PUT_YOUR_bridge.py_HERE.txt`.

2. **msgpack.** Проект не ставит `msgpack` через pip — в списке
   пакетов, которые Chaquopy умеет собирать под Android, его нет,
   а собирать C-расширение через NDK на удачу не хотелось. Вместо
   этого добавлен `msgpack_lite.py` — чистый Python, реализующий
   ровно `packb()`/`unpackb()` в том объёме, в котором их использует
   `bridge.py`. У себя в `bridge.py` замените:
   ```python
   import msgpack
   ```
   на:
   ```python
   import msgpack_lite as msgpack
   ```
   (это единственное изменение, которое нужно внести в исходник).

   Если предпочитаете настоящий `msgpack` — можно попробовать добавить
   `install "msgpack"` в `chaquopy.defaultConfig.pip` в `app/build.gradle`;
   Chaquopy попытается собрать C-расширение через Android NDK. Иногда
   это работает, иногда нет — судить проще по логам конкретного billing
   GitHub Actions. `msgpack_lite.py` — гарантированно рабочий запасной
   вариант.

3. **lz4** ставится как обычный pip-пакет — Chaquopy для него
   уже имеет готовую Android-сборку, ничего делать не нужно.

## Токен сессии — важно

`session.json` **не входит** в репозиторий (см. `.gitignore`) и не
кладётся в APK. При первом запуске приложение создаст пустую сессию
и попросит логин — как обычно.

Если хотите перенести уже существующий `session.json` (с рабочим
токеном) на телефон, не публикуя его в GitHub — сделайте это локально
через adb, уже после установки debug-APK:

```bash
adb push session.json /sdcard/session.json
adb shell run-as com.example.maxclient sh -c \
  'cp /sdcard/session.json files/session.json'
adb shell rm /sdcard/session.json
```

(`run-as` работает для debug-сборки без root.)

## Сборка через GitHub Actions

Всё уже настроено в `.github/workflows/android-build.yml`:
- при пуше в `main` или вручную (`workflow_dispatch`) собирается
  debug APK;
- готовый файл появляется во вкладке **Actions → (запуск) → Artifacts**
  как `max-client-debug-apk`.

Локально (если нужно): `gradle assembleDebug` — итоговый файл будет
в `app/build/outputs/apk/debug/app-debug.apk`.

## Иконка

Сейчас — простая заглушка (тёмный кружок с буквой «M»), сгенерированная
автоматически. Замените PNG-файлы в `app/src/main/res/mipmap-*/`
на свои, если нужна другая картинка.

## О чём стоит знать

- `applicationId` сейчас `com.example.maxclient` — при желании
  поменяйте на что-то своё в `app/build.gradle` (и переименуйте
  package в `MainActivity.kt`, если хотите единообразия).
- Сборка debug — приложение подписано debug-ключом, для личного
  использования этого достаточно. Для публикации в Play Store
  потребуется release-подпись — это отдельная настройка
  (keystore + секреты в GitHub Actions).
- Если Flask-роут, который отдаёт `index.html`, у вас в `bridge.py`
  берёт путь через `os.path.dirname(__file__)` (что типично для
  `send_from_directory(...)`), всё отработает само — `index.html`
  и bridge.py лежат в одной папке `app/src/main/python/`, и Chaquopy
  извлекает эту папку на устройство целиком при первом запуске
  (файлы становятся доступны относительно `__file__` как обычные
  файлы на диске).
- Для iOS/desktop потребуется другой подход (Chaquopy — Android-only);
  можно отдельно спросить, если понадобится.
