#!/usr/bin/env bash
# Раскладывает файлы патча по дереву репозитория — один в один, по тем же
# относительным путям. Принимает (по приоритету):
#   1. путь, переданный первым аргументом — zip-файл или уже распакованная папка;
#   2. единственный *.zip, лежащий в корне репозитория (просто брось его туда);
#   3. папку ./patch рядом с корнем репозитория.
#
# Запускать из корня репозитория:
#   bash scripts/apply-patch.sh            # сам найдёт zip в корне
#   bash scripts/apply-patch.sh путь.zip    # конкретный zip
#   bash scripts/apply-patch.sh путь/patch  # уже распакованная папка
#
# Перед каждой заменой существующий файл сохраняется в .patch-backup/ (с тем
# же относительным путём и меткой времени) — на случай, если что-то пошло не
# так и нужно откатиться вручную. Новые файлы (которых в репозитории раньше
# не было) создаются как есть, без бэкапа (нечего бэкапить).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

INPUT="${1:-}"
# Тут, а не внутри extract_zip() — функция вызывается через командную
# подстановку $(...), которая выполняется в сабшелле, и любое присваивание
# переменной ВНУТРИ ннего в родительском скрипте не видно. Поэтому
# TMP_EXTRACT создаём здесь заранее и передаём внутрь явно.
TMP_EXTRACT="$(mktemp -d)"
cleanup() {
    if [[ -n "$TMP_EXTRACT" && -d "$TMP_EXTRACT" ]]; then
        rm -rf "$TMP_EXTRACT"
    fi
}
trap cleanup EXIT

extract_zip() {
    # $1 — путь к zip-файлу, $2 — куда распаковать (уже существующая папка).
    if command -v unzip >/dev/null 2>&1; then
        unzip -q "$1" -d "$2"
    elif command -v bsdtar >/dev/null 2>&1; then
        bsdtar -xf "$1" -C "$2"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$1" "$2"
    else
        echo "::error:: Не нашёл ни unzip, ни bsdtar, ни python3, чтобы распаковать zip. Установи unzip (в Termux: pkg install unzip) или распакуй архив вручную и передай скрипту путь к папке."
        exit 1
    fi
}

if [[ -n "$INPUT" ]]; then
    if [[ -f "$INPUT" && "$INPUT" == *.zip ]]; then
        echo "[apply-patch] Распаковываю $INPUT"
        extract_zip "$INPUT" "$TMP_EXTRACT"
        PATCH_DIR="$TMP_EXTRACT"
    elif [[ -d "$INPUT" ]]; then
        PATCH_DIR="$INPUT"
    else
        echo "::error:: Не нашёл ни такой файл/папку: $INPUT"
        exit 1
    fi
else
    # Аргумент не передали — ищем единственный *.zip в корне репозитория.
    mapfile -t ZIPS < <(find "$ROOT_DIR" -maxdepth 1 -iname "*.zip")
    if [[ ${#ZIPS[@]} -eq 1 ]]; then
        echo "[apply-patch] Нашёл архив: ${ZIPS[0]}"
        extract_zip "${ZIPS[0]}" "$TMP_EXTRACT"
        PATCH_DIR="$TMP_EXTRACT"
    elif [[ ${#ZIPS[@]} -gt 1 ]]; then
        echo "::error:: В корне репозитория несколько zip-файлов, не могу угадать нужный:"
        printf '  %s\n' "${ZIPS[@]}"
        echo "Укажи явно: bash scripts/apply-patch.sh путь-к-нужному.zip"
        exit 1
    elif [[ -d "$ROOT_DIR/patch" ]]; then
        PATCH_DIR="$ROOT_DIR/patch"
    else
        echo "::error:: Не нашёл ни zip-файла в корне репозитория, ни папки ./patch."
        echo "Либо брось архив с патчем прямо в корень репозитория и запусти скрипт снова, либо укажи путь явно."
        exit 1
    fi
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=".patch-backup/$TS"
copied=0
created=0

echo "[apply-patch] Источник: $PATCH_DIR"
echo "[apply-patch] Бэкапы заменяемых файлов: $BACKUP_DIR"
echo

# find выводит пути файлов внутри PATCH_DIR; это же дерево воспроизводим
# относительно корня репозитория.
while IFS= read -r -d '' src; do
    rel="${src#"$PATCH_DIR"/}"
    dest="$ROOT_DIR/$rel"

    if [[ -f "$dest" ]]; then
        mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
        cp "$dest" "$BACKUP_DIR/$rel"
        echo "[заменяю]  $rel  (бэкап -> $BACKUP_DIR/$rel)"
        copied=$((copied + 1))
    else
        echo "[создаю]   $rel  (новый файл)"
        created=$((created + 1))
    fi

    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
done < <(find "$PATCH_DIR" -type f ! -path "$PATCH_DIR/scripts/apply-patch.sh" -print0)

echo
echo "[apply-patch] Готово: заменено $copied, создано $created."
if [[ $copied -gt 0 ]]; then
    echo "[apply-patch] Старые версии заменённых файлов лежат в $BACKUP_DIR/ — проверь \`git diff\` и удали бэкап, когда убедишься, что всё в порядке."
fi
echo "[apply-patch] Дальше: просмотри \`git status\` / \`git diff\`, и коммить сам — скрипт ничего не коммитит и не пушит."
