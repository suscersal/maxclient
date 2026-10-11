#!/usr/bin/env bash
# Синхронизирует единственный "источник правды" (корневой bridge.py +
# static/*) в папку Chaquopy для Android-сборки.
#
# Запускать из корня репозитория:
#   bash scripts/sync-android-python.sh
#
# Используется как локально (перед открытием Android Studio / gradle),
# так и в GitHub Actions (шаг перед сборкой APK).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEST="android/app/src/main/python"

echo "[sync] Копирую bridge.py -> $DEST/bridge.py"
cp bridge.py "$DEST/bridge.py"

echo "[sync] Копирую static/*.json и index.html и gifы -> $DEST/"
cp static/index.html "$DEST/index.html"
cp static/manifest.json "$DEST/manifest.json"
cp static/loading.gif "$DEST/loading.gif"
cp -r static/assets/. "$DEST/assets"

# Интерфейс /tg/ (Telegram Web K, ~3000 файлов). bridge.py раздаёт его из
# <папка bridge.py>/tg, поэтому в Android-сборке он должен лежать в $DEST/tg.
# Сначала чистим старую копию: имена файлов в сборке хэшированные
# (index-CnT2cwDd.js и т.п.), и при обновлении tweb старые файлы
# иначе остались бы в APK мусором.
echo "[sync] Копирую static/tg -> $DEST/tg (интерфейс /tg/)"
rm -rf "$DEST/tg"
mkdir -p "$DEST/tg"
cp -r static/tg/. "$DEST/tg"
test -f "$DEST/tg/index.html" || { echo "[sync] ОШИБКА: $DEST/tg/index.html не найден после копирования" >&2; exit 1; }

DEST_ASSETS="android/app/src/main/assets"
echo "[sync] Копирую loading.gif -> $DEST_ASSETS/loading.gif (нативный Android assets, читает GifView.kt через context.assets)"
mkdir -p "$DEST_ASSETS"
cp static/loading.gif "$DEST_ASSETS/loading.gif"

echo "[sync] Патчу импорт msgpack -> msgpack_lite (Chaquopy не собирает C-расширение msgpack)"
# Файлы в проекте с CRLF-переносами строк, поэтому учитываем необязательный \r перед концом строки
sed -i.bak 's/^import msgpack\r\{0,1\}$/import msgpack_lite as msgpack\r/' "$DEST/bridge.py"
rm -f "$DEST/bridge.py.bak"

echo "[sync] Готово."