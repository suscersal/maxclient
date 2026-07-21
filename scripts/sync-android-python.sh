#!/usr/bin/env bash
# Синхронизирует единственный "исходник правды" (корневой bridge.py +
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

echo "[sync] Копирую static/*.json и index.html -> $DEST/"
cp static/index.html "$DEST/index.html"
cp static/avatars.json "$DEST/avatars.json"
cp static/manifest.json "$DEST/manifest.json"

echo "[sync] Патчу импорт msgpack -> msgpack_lite (Chaquopy не собирает C-расширение msgpack)"
# Файлы в проекте с CRLF-переносами строк, поэтому учитываем необязательный \r перед концом строки
sed -i.bak 's/^import msgpack\r\{0,1\}$/import msgpack_lite as msgpack\r/' "$DEST/bridge.py"
rm -f "$DEST/bridge.py.bak"

echo "[sync] Готово."