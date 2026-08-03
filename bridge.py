import json
import logging
import os
import queue
import random
import re
import secrets
import socket
import ssl
import struct
import threading
import time
import uuid
import gzip
import html

import msgpack
from flask import Flask, send_from_directory, request, jsonify, Response, stream_with_context
from flask_sock import Sock
import lz4.block
import urllib.request
import urllib.error
import urllib.parse
import base64
import hashlib
import csv
import io

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# --- Конфигурация ---
HOST = os.getenv("MAX_HOST", "api.oneme.ru")
PORT = int(os.getenv("MAX_PORT", "443"))
SESSION_FILE = os.getenv("SESSION_FILE", os.path.join(
    os.path.dirname(__file__), "session.json"))
SESSION_KEY_FILE = os.path.join(os.path.dirname(SESSION_FILE), "session.key")
# Локальный кэш списка чатов — показываем его офлайн, если сервер недоступен
# и лимит попыток переподключения исчерпан.
CHATS_CACHE_FILE = os.getenv("CHATS_CACHE_FILE", os.path.join(
    os.path.dirname(__file__), "chats_cache.json"))
# Локальный кэш последних сообщений по каждому чату (для офлайн-режима —
# чтобы при открытии чата без сети показывались хотя бы последние сообщения,
# а не пустой список). Хранит не более MESSAGES_CACHE_LIMIT сообщений на чат.
MESSAGES_CACHE_FILE = os.getenv("MESSAGES_CACHE_FILE", os.path.join(
    os.path.dirname(__file__), "messages_cache.json"))
MESSAGES_CACHE_LIMIT = 20
# lottie-web (анимации стикеров/лоадера) — не бандлим в сборку, а качаем один
# раз при первом (заведомо онлайн) запуске и кэшируем рядом с session.json.
# Дальше раздаём с диска (см. ensure_lottie_cached() и роут /lottie.min.js
# ниже) — интернет для этого больше не нужен.
LOTTIE_CACHE_FILE = os.getenv("LOTTIE_CACHE_FILE", os.path.join(
    os.path.dirname(SESSION_FILE), "lottie.min.js"))
LOTTIE_DOWNLOAD_URL = "https://raw.githubusercontent.com/airbnb/lottie-web/master/build/player/lottie.min.js"
# Полный каталог устройств, сертифицированных Google Play (Retail Branding /
# Marketing Name / Device / Model) — официальный публичный список Google,
# обновляется у них регулярно. Качаем один раз и кэшируем на диск (как
# lottie.min.js выше), чтобы список профилей устройств не был захардкожен и
# не требовал обновления бриджа вручную при выходе новых телефонов.
DEVICE_CATALOG_URL = "https://storage.googleapis.com/play_public/supported_devices.csv"
# Запасной вариант на случай, если .csv когда-нибудь станет недоступен —
# та же самая таблица, но отдаётся как HTML-страница (с той же датой
# обновления). Пробуем эту ссылку только если CSV не скачался.
DEVICE_CATALOG_HTML_FALLBACK_URL = "https://storage.googleapis.com/play_public/supported_devices.html"
DEVICE_CATALOG_FILE = os.getenv("DEVICE_CATALOG_FILE", os.path.join(
    os.path.dirname(SESSION_FILE), "device_catalog.json"))
DEVICE_CATALOG_REFRESH_HOURS = 24 * 7  # раз в неделю доскачиваем свежую версию
VERSION_CACHE_HOURS = 24
FALLBACK_APP_VERSION = "26.15.0"

# --- Локальная проверка сообщений на скам (опционально, выключено по умолчанию) ---
# Использует ЛЮБОЙ локальный сервер инференса с OpenAI-совместимым
# /v1/chat/completions (Ollama — localhost:11434, llama.cpp server —
# localhost:8080/8081, LM Studio — localhost:1234, и т.п.). Пользователь сам
# поднимает сервер и сам скачивает модель (например, с HuggingFace или из
# репозитория на GitHub) — бридж лишь стучится на указанный адрес и никуда
# больше сообщения не отправляет.
SCAM_CHECK_DEFAULT_URL = "http://localhost:11434/v1/chat/completions"
SCAM_CHECK_DEFAULT_MODEL = "llama3.1"
SCAM_CHECK_TIMEOUT = int(os.getenv("SCAM_CHECK_TIMEOUT", "20"))
SCAM_CHECK_SYSTEM_PROMPT = (
    "Ты — детектор мошеннических (скам) сообщений в мессенджере. Тебе дают "
    "текст одного сообщения. Определи, похоже ли оно на мошенничество, "
    "фишинг или социальную инженерию (просьбы перевести деньги, поддельные "
    "ссылки на 'службу поддержки', выигрыши/призы, шантаж, поддельные "
    "начальники/родственники/банки и т.п.). Ответь СТРОГО в виде JSON без "
    "какого-либо текста вокруг: "
    '{"is_scam": true|false, "confidence": 0-100, "reason": "краткое объяснение по-русски"}'
)


def _get_scam_check_settings():
    sess = load_session()
    cfg = sess.get("scamCheck", {})
    return {
        "enabled": bool(cfg.get("enabled", False)),
        "url": cfg.get("url") or SCAM_CHECK_DEFAULT_URL,
        "model": cfg.get("model") or SCAM_CHECK_DEFAULT_MODEL,
        # Модели Gemma на HuggingFace — gated: чтобы их скачать, недостаточно
        # прямой ссылки, нужен персональный токен пользователя, который
        # принял лицензию на странице модели (иначе сервер отвечает 401).
        # См. https://huggingface.co/litert-community/Gemma3-1B-IT — кнопка
        # "Acknowledge license", затем токен в Settings -> Access Tokens.
        "hfToken": cfg.get("hfToken", ""),
    }


def _save_scam_check_settings(patch: dict):
    sess = load_session()
    cfg = sess.get("scamCheck", {})
    cfg.update({k: v for k, v in patch.items() if v is not None})
    sess["scamCheck"] = cfg
    save_session(sess)
    return cfg


# --- On-device движок (Android): MediaPipe LLM Inference через Chaquopy ---
# На Android нет способа "просто попросить пользователя поставить Ollama" —
# поэтому здесь модель выполняется ПРЯМО в процессе приложения через
# com.google.mediapipe:tasks-genai (см. android/app/build.gradle) — Chaquopy
# позволяет дёргать этот Java-класс прямо из Python (`from com.google... import`).
# На обычном ПК (когда bridge.py запускают как python bridge.py, а не внутри
# APK) этот импорт просто упадёт — тогда используется fallback на внешний
# OpenAI-совместимый сервер (см. _get_scam_check_settings/url выше).
GEMMA_MODEL_FILE = os.getenv("GEMMA_MODEL_FILE", os.path.join(
    os.path.dirname(SESSION_FILE), "gemma3-1b-it-int4.task"))
# Официальная LiteRT-сборка Gemma 3 1B (4-бит) с HuggingFace — тот же файл,
# что используется в официальных примерах Google для LLM Inference API.
# ВАЖНО: репозиторий gated (требует принять лицензию Gemma + HF-токен),
# иначе сервер отвечает 401 — см. hfToken в _get_scam_check_settings.
GEMMA_MODEL_DOWNLOAD_URL = os.getenv(
    "GEMMA_MODEL_DOWNLOAD_URL",
    "https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.task",
)

_android_context = None
_llm_engine = None
_llm_engine_lock = threading.Lock()
_model_download_state = {
    "downloading": False,
    "ready": False,
    "error": None,
    "downloadedBytes": 0,
    "totalBytes": 0,
}


def set_android_context(ctx):
    """Вызывается один раз из bridge_launcher.start_server() сразу после
    импорта модуля — Context нужен MediaPipe для инициализации модели.
    На десктопе (python bridge.py напрямую) никогда не вызывается — ничего
    страшного, просто останется None и on-device движок не заработает."""
    global _android_context
    _android_context = ctx
    # Если проверка уже была включена в прошлый раз — начинаем качать модель
    # сразу в фоне, не дожидаясь первого сообщения.
    if _get_scam_check_settings()["enabled"]:
        threading.Thread(target=ensure_gemma_model_cached, daemon=True).start()


def ensure_gemma_model_cached():
    """Качает .task-модель (несколько сотен МБ даже в 4-бит квантовании)
    один раз и кладёт её рядом с session.json, с прогрессом в
    _model_download_state (см. /api/scam-check/model-status). Если файл уже
    есть — не трогает сеть вообще. Не блокирует запуск бриджа — вызывается в
    фоновом потоке (см. set_android_context и /api/scam-check/settings)."""
    if os.path.exists(GEMMA_MODEL_FILE):
        _model_download_state["ready"] = True
        return True
    if _model_download_state["downloading"]:
        return False
    _model_download_state.update({
        "downloading": True, "error": None,
        "downloadedBytes": 0, "totalBytes": 0,
    })
    try:
        logger.info(
            "[scam-check] downloading on-device model (one-time, ~500MB+)…")
        headers = {"User-Agent": "Mozilla/5.0"}
        hf_token = (_get_scam_check_settings().get("hfToken") or "").strip()
        if hf_token:
            headers["Authorization"] = f"Bearer {hf_token}"
        req = urllib.request.Request(GEMMA_MODEL_DOWNLOAD_URL, headers=headers)
        tmp_path = GEMMA_MODEL_FILE + ".part"
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = resp.getheader("Content-Length")
            _model_download_state["totalBytes"] = int(total) if total else 0
            with open(tmp_path, "wb") as f:
                downloaded = 0
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    _model_download_state["downloadedBytes"] = downloaded
        os.replace(tmp_path, GEMMA_MODEL_FILE)
        logger.info("[scam-check] model downloaded successfully")
        _model_download_state["ready"] = True
        return True
    except urllib.error.HTTPError as e:
        if e.code == 401 or e.code == 403:
            msg = ("нет доступа к модели (401/403) — модель Gemma на HuggingFace "
                   "требует принять лицензию и указать личный токен в настройках")
        else:
            msg = f"HTTP {e.code}: {e.reason}"
        logger.warning(f"[scam-check] model download failed: {msg}")
        _model_download_state["error"] = msg
        return False
    except Exception as e:
        logger.warning(f"[scam-check] model download failed: {e}")
        _model_download_state["error"] = str(e)
        return False
    finally:
        _model_download_state["downloading"] = False


def delete_gemma_model():
    """Удаляет скачанную модель с диска (кнопка 'Удалить модель' в
    настройках) — освобождает место, если проверка больше не нужна.
    Заодно сбрасывает уже проинициализированный движок в памяти, чтобы
    следующий запрос на скам-проверку не пытался юзать закрытый файл."""
    global _llm_engine
    with _llm_engine_lock:
        _llm_engine = None
    removed = False
    for path in (GEMMA_MODEL_FILE, GEMMA_MODEL_FILE + ".part"):
        if os.path.exists(path):
            try:
                os.remove(path)
                removed = True
            except Exception as e:
                logger.warning(f"[scam-check] failed to delete {path}: {e}")
    _model_download_state.update({
        "ready": False, "downloading": False, "error": None,
        "downloadedBytes": 0, "totalBytes": 0,
    })
    return removed


_llm_init_error = None


def get_on_device_llm():
    """Ленивая инициализация on-device движка. Возвращает None (без
    исключений), если приложение не на Android, зависимость tasks-genai не
    подключена в Gradle, модель ещё не скачана, или инициализация упала —
    вызывающий код тогда сам решает, использовать ли fallback на внешний
    сервер. Причина последнего провала сохраняется в _llm_init_error, чтобы
    её можно было вернуть в API-ответе (см. _run_scam_check), а не только
    смотреть в adb logcat."""
    global _llm_engine, _llm_init_error
    if _llm_engine is not None:
        return _llm_engine
    if _android_context is None:
        return None
    with _llm_engine_lock:
        if _llm_engine is not None:
            return _llm_engine
        try:
            from com.google.mediapipe.tasks.genai.llminference import LlmInference
        except Exception as e:
            _llm_init_error = f"MediaPipe import failed: {e}"
            logger.info(
                f"[scam-check] MediaPipe недоступен (не Android-сборка?): {e}")
            return None
        if not os.path.exists(GEMMA_MODEL_FILE):
            return None
        try:
            options = LlmInference.LlmInferenceOptions.builder() \
                .setModelPath(GEMMA_MODEL_FILE) \
                .setMaxTokens(512) \
                .build()
            _llm_engine = LlmInference.createFromOptions(
                _android_context, options)
            _llm_init_error = None
            logger.info("[scam-check] on-device LLM initialized")
        except Exception as e:
            _llm_init_error = str(e)
            logger.warning(f"[scam-check] failed to init on-device model: {e}")
            _llm_engine = None
        return _llm_engine


def _parse_scam_verdict_text(content: str):
    """Общий разбор ответа модели (и on-device, и внешней) — модели любят
    оборачивать JSON в ```json ... ```, снимаем обёртку и парсим."""
    cleaned = re.sub(r"^```(?:json)?|```$", "", content.strip(),
                     flags=re.MULTILINE).strip()
    verdict = json.loads(cleaned)
    return {
        "is_scam": bool(verdict.get("is_scam", False)),
        "confidence": verdict.get("confidence"),
        "reason": verdict.get("reason", ""),
    }


TIMEOUT = int(os.getenv("SOCKET_TIMEOUT", "15"))
# Сколько ждём подключения к серверу MAX, прежде чем считать, что интернета
# нет, и сообщить об этом клиенту, а не зависать навсегда (см. connect() и
# relay() ниже — раньше socket.create_connection() не имел таймаута вовсе).
CONNECT_TIMEOUT = int(os.getenv("CONNECT_TIMEOUT", "7"))


# --- Шифрование session.json на диске ---
# Без сторонних пакетов (не хотим тащить cryptography в Android-сборку через
# Chaquopy — рискованно) — простой, но настоящий потоковый шифр на hashlib.
# Ключ лежит в отдельном файле session.key рядом с session.json; если кто-то
# получит доступ к папке приложения целиком, оба файла всё равно будут видны —
# это защита от случайного просмотра/утечки одного файла, не от root-доступа.
def _get_or_create_encryption_key() -> bytes:
    if os.path.exists(SESSION_KEY_FILE):
        with open(SESSION_KEY_FILE, "rb") as f:
            return f.read()
    key = secrets.token_bytes(32)
    with open(SESSION_KEY_FILE, "wb") as f:
        f.write(key)
    try:
        os.chmod(SESSION_KEY_FILE, 0o600)
    except Exception:
        pass
    return key


def _keystream(key: bytes, length: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(key + counter.to_bytes(8, "big")).digest()
        counter += 1
    return bytes(out[:length])


def _xor_bytes(data: bytes, key: bytes) -> bytes:
    ks = _keystream(key, len(data))
    return bytes(a ^ b for a, b in zip(data, ks))


def _encrypt_session_dict(data: dict) -> str:
    key = _get_or_create_encryption_key()
    raw = json.dumps(data).encode("utf-8")
    cipher = _xor_bytes(raw, key)
    return base64.b64encode(cipher).decode("ascii")


def _decrypt_session_blob(blob: str) -> dict:
    key = _get_or_create_encryption_key()
    cipher = base64.b64decode(blob.encode("ascii"))
    raw = _xor_bytes(cipher, key)
    return json.loads(raw.decode("utf-8"))


# --- Работа с сессией ---
def load_session():
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE) as f:
                content = f.read()
            # Поддержка старого формата (обычный plaintext JSON) для плавного
            # перехода — если файл ещё не зашифрован, читаем как есть и при
            # следующем save_session он уже сохранится зашифрованным.
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return _decrypt_session_blob(content)
        except Exception as e:
            logger.warning(f"[session] failed to load: {e}")
    return {}


def save_session(data: dict):
    encrypted = _encrypt_session_dict(data)
    with open(SESSION_FILE, "w") as f:
        f.write(encrypted)
    try:
        os.chmod(SESSION_FILE, 0o600)
    except Exception:
        pass


def load_chats_cache():
    """Читает последний сохранённый на диск список чатов (для офлайн-режима).
    Файл хранится зашифрованным тем же ключом, что и session.json (см.
    _encrypt_session_dict/_decrypt_session_blob) — старый формат (обычный
    plaintext JSON) тоже поддерживается для плавного перехода."""
    if os.path.exists(CHATS_CACHE_FILE):
        try:
            with open(CHATS_CACHE_FILE, "r", encoding="utf-8") as f:
                content = f.read()
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return _decrypt_session_blob(content)
        except Exception as e:
            logger.warning(f"[chats-cache] failed to load: {e}")
    return None


def save_chats_cache(data: dict):
    """Сохраняет список чатов на диск (зашифрованным, как session.json),
    чтобы показать их офлайн при отсутствии сети."""
    try:
        encrypted = _encrypt_session_dict(data)
        tmp_path = CHATS_CACHE_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(encrypted)
        os.replace(tmp_path, CHATS_CACHE_FILE)
        try:
            os.chmod(CHATS_CACHE_FILE, 0o600)
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"[chats-cache] failed to save: {e}")


def ensure_lottie_cached():
    """Если lottie.min.js ещё не скачан — качает его один раз и сохраняет на
    диск рядом с session.json. Если файл уже есть — ничего не делает (и сеть
    не трогает). Вызывается в фоновом потоке при старте, плюс лениво из
    роута /lottie.min.js на случай, если фонового скачивания не хватило."""
    if os.path.exists(LOTTIE_CACHE_FILE):
        return True
    try:
        req = urllib.request.Request(
            LOTTIE_DOWNLOAD_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
        tmp_path = LOTTIE_CACHE_FILE + ".tmp"
        with open(tmp_path, "wb") as f:
            f.write(data)
        os.replace(tmp_path, LOTTIE_CACHE_FILE)
        logger.info(
            f"[lottie] Скачан и сохранён в {LOTTIE_CACHE_FILE} ({len(data)} байт)")
        return True
    except Exception as e:
        logger.warning(f"[lottie] Не удалось скачать (нет сети?): {e}")
        return False


def _ensure_lottie_cached_background():
    threading.Thread(target=ensure_lottie_cached, daemon=True).start()


# Пытаемся скачать сразу при старте (сервер стартует не дожидаясь этого —
# поток фоновый), чтобы к моменту, когда фронтенд запросит /lottie.min.js,
# файл уже с высокой вероятностью был на диске.
_ensure_lottie_cached_background()


# --- Каталог устройств (скачивается из интернета, не хардкодится) ---
# Официальный CSV Google Play с полным списком Play-сертифицированных
# устройств (колонки: Retail Branding, Marketing Name, Device, Model).
# Экран/архитектура/версия Android в этом файле не публикуются — Google
# отдаёт только названия устройств, поэтому для полей userAgent, которых в
# CSV нет, используются разумные типовые значения (см. _GENERIC_SCREEN_POOL).
_GENERIC_SCREEN_POOL = [
    "xhdpi 400dpi 1080x2400",
    "xxhdpi 440dpi 1080x2340",
    "xxhdpi 460dpi 1200x2670",
    "xxxhdpi 480dpi 1440x3120",
]


def _parse_device_catalog_csv(raw_bytes: bytes) -> list:
    """Парсит официальный CSV Google Play в список маркетинговых названий
    устройств. Файл отдаётся в UTF-16 с BOM; на случай изменения формата
    Google — пробуем несколько кодировок по очереди."""
    text = None
    for enc in ("utf-16", "utf-8-sig", "utf-8", "cp1251"):
        try:
            text = raw_bytes.decode(enc)
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
    if text is None:
        raise ValueError("Не удалось определить кодировку CSV")

    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return []

    header = [h.strip().lower() for h in rows[0]]
    try:
        brand_idx = header.index("retail branding")
    except ValueError:
        brand_idx = 0
    try:
        name_idx = header.index("marketing name")
    except ValueError:
        name_idx = 1

    seen = set()
    names = []
    for row in rows[1:]:
        if len(row) <= max(brand_idx, name_idx):
            continue
        brand = row[brand_idx].strip()
        marketing = row[name_idx].strip()
        if not marketing:
            continue
        full_name = marketing if marketing.lower().startswith(
            brand.lower()) else f"{brand} {marketing}".strip()
        full_name = " ".join(full_name.split())  # схлопнуть повторные пробелы
        if full_name and full_name not in seen:
            seen.add(full_name)
            names.append(full_name)
    return names


def _parse_device_catalog_html(raw_bytes: bytes) -> list:
    """Запасной парсер: та же таблица устройств, но со страницы
    supported_devices.html вместо .csv (используется только если CSV не
    скачался). Страница — простая HTML-таблица без JS, поэтому регулярки
    по <tr>/<td> достаточно, без тяжёлых HTML-парсеров."""
    text = None
    for enc in ("utf-8", "utf-8-sig", "cp1251"):
        try:
            text = raw_bytes.decode(enc)
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
    if text is None:
        raise ValueError("Не удалось определить кодировку HTML")

    def _strip_tags(cell: str) -> str:
        return html.unescape(re.sub(r"<[^>]+>", "", cell)).strip()

    rows = re.findall(r"<tr>(.*?)</tr>", text, re.S)
    seen = set()
    names = []
    header_skipped = False
    for row in rows:
        cells = [_strip_tags(c) for c in re.findall(
            r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        if not header_skipped:
            header_skipped = True
            if cells[:2] == ["Retail Branding", "Marketing Name"]:
                continue  # это была строка заголовка — пропускаем
        if len(cells) < 2:
            continue
        brand, marketing = cells[0], cells[1]
        if not marketing:
            continue
        full_name = marketing if marketing.lower().startswith(
            brand.lower()) else f"{brand} {marketing}".strip()
        full_name = " ".join(full_name.split())
        if full_name and full_name not in seen:
            seen.add(full_name)
            names.append(full_name)
    return names


def ensure_device_catalog_cached(force: bool = False) -> bool:
    """Качает официальный список устройств Google Play и кэширует его на
    диск в виде JSON (список названий + время скачивания). Если кэш уже
    есть и свежий (моложе DEVICE_CATALOG_REFRESH_HOURS) — сеть не трогаем,
    если force=True — качаем принудительно (см. /api/device-catalog/refresh).
    Основной источник — CSV; если он недоступен, пробуем HTML-страницу с
    той же таблицей (см. DEVICE_CATALOG_HTML_FALLBACK_URL)."""
    if not force and os.path.exists(DEVICE_CATALOG_FILE):
        try:
            with open(DEVICE_CATALOG_FILE, "r", encoding="utf-8") as f:
                cached = json.load(f)
            age_hours = (time.time() - cached.get("fetched_at", 0)) / 3600
            if age_hours < DEVICE_CATALOG_REFRESH_HOURS and cached.get("devices"):
                return True
        except Exception:
            pass  # кэш повреждён — перекачаем ниже

    names = None
    source = None
    try:
        req = urllib.request.Request(
            DEVICE_CATALOG_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
        names = _parse_device_catalog_csv(raw)
        source = "csv"
    except Exception as e:
        logger.warning(
            f"[device-catalog] CSV не скачался, пробуем HTML-фолбэк: {e}")
        try:
            req = urllib.request.Request(
                DEVICE_CATALOG_HTML_FALLBACK_URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            names = _parse_device_catalog_html(raw)
            source = "html"
        except Exception as e2:
            logger.warning(
                f"[device-catalog] HTML-фолбэк тоже не скачался: {e2}")
            return False

    if not names:
        logger.warning(
            "[device-catalog] Пустой список устройств после парсинга")
        return False

    payload = {"fetched_at": time.time(), "devices": names, "source": source}
    tmp_path = DEVICE_CATALOG_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp_path, DEVICE_CATALOG_FILE)
    logger.info(
        f"[device-catalog] Скачано {len(names)} устройств ({source}), сохранено в {DEVICE_CATALOG_FILE}")
    return True


def load_device_catalog() -> list:
    """Читает закэшированный список названий устройств с диска. Если файла
    ещё нет (сеть при старте была недоступна) — возвращает []."""
    if not os.path.exists(DEVICE_CATALOG_FILE):
        return []
    try:
        with open(DEVICE_CATALOG_FILE, "r", encoding="utf-8") as f:
            return json.load(f).get("devices", [])
    except Exception as e:
        logger.warning(f"[device-catalog] failed to load cache: {e}")
        return []


def _ensure_device_catalog_cached_background():
    threading.Thread(target=ensure_device_catalog_cached, daemon=True).start()


# Как и с lottie — качаем сразу при старте в фоновом потоке, не блокируя
# запуск сервера. Раз в неделю кэш будет обновляться сам при следующем
# обращении к /api/device-catalog.
_ensure_device_catalog_cached_background()


def load_messages_cache() -> dict:
    """Читает кэш последних сообщений по чатам (зашифрован так же, как
    session.json). Формат: {"<chatId>": {"messages": [...], "savedAt": ms}}."""
    if os.path.exists(MESSAGES_CACHE_FILE):
        try:
            with open(MESSAGES_CACHE_FILE, "r", encoding="utf-8") as f:
                content = f.read()
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return _decrypt_session_blob(content)
        except Exception as e:
            logger.warning(f"[messages-cache] failed to load: {e}")
    return {}


def save_messages_cache(data: dict):
    """Сохраняет кэш последних сообщений по чатам на диск, зашифрованным
    тем же ключом, что и session.json."""
    try:
        encrypted = _encrypt_session_dict(data)
        tmp_path = MESSAGES_CACHE_FILE + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(encrypted)
        os.replace(tmp_path, MESSAGES_CACHE_FILE)
        try:
            os.chmod(MESSAGES_CACHE_FILE, 0o600)
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"[messages-cache] failed to save: {e}")


def get_or_create_device_id() -> str:
    sess = load_session()
    if "deviceId" not in sess:
        sess["deviceId"] = str(uuid.uuid4())
        save_session(sess)
    return sess["deviceId"]


def regenerate_device_id() -> str:
    """Полная пересборка ID устройства — сервер MAX увидит это как новое
    устройство (может потребовать заново пройти авторизацию/код)."""
    sess = load_session()
    sess["deviceId"] = str(uuid.uuid4())
    save_session(sess)
    return sess["deviceId"]


# Пресеты профилей устройства для handshake (userAgent). Ключ — id, значение —
# сами поля userAgent, кроме appVersion (она всегда берётся отдельно, через
# get_latest_app_version()).
DEVICE_PROFILES = {
    "samsung_s24_ultra": {
        "label": "Samsung Galaxy S24 Ultra / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Samsung Galaxy S24 Ultra", "screen": "xxxhdpi 480dpi 1440x3120",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "samsung_s24": {
        "label": "Samsung Galaxy S24 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Samsung Galaxy S24", "screen": "xxhdpi 480dpi 1080x2340",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "samsung_s23": {
        "label": "Samsung Galaxy S23 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Samsung Galaxy S23", "screen": "xxhdpi 480dpi 1080x2340",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "samsung_a55": {
        "label": "Samsung Galaxy A55 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Samsung Galaxy A55", "screen": "xhdpi 420dpi 1080x2340",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "pixel_9_pro": {
        "label": "Google Pixel 9 Pro / Android 15",
        "deviceType": "ANDROID", "osVersion": "Android 15",
        "deviceName": "Google Pixel 9 Pro", "screen": "xxxhdpi 495dpi 1280x2856",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "pixel_9": {
        "label": "Google Pixel 9 / Android 15",
        "deviceType": "ANDROID", "osVersion": "Android 15",
        "deviceName": "Google Pixel 9", "screen": "xxhdpi 422dpi 1080x2424",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "pixel_8": {
        "label": "Google Pixel 8 / Android 15",
        "deviceType": "ANDROID", "osVersion": "Android 15",
        "deviceName": "Google Pixel 8", "screen": "xxhdpi 420dpi 1080x2400",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "pixel_7": {
        "label": "Google Pixel 7 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Google Pixel 7", "screen": "xxhdpi 416dpi 1080x2400",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "xiaomi_14": {
        "label": "Xiaomi 14 / Android 14 (HyperOS)",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Xiaomi 14", "screen": "xxxhdpi 480dpi 1200x2670",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "redmi_note_14": {
        "label": "Xiaomi Redmi Note 14 / Android 14 (HyperOS)",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Xiaomi Redmi Note 14", "screen": "xhdpi 395dpi 1080x2400",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "poco_x6": {
        "label": "Poco X6 Pro / Android 14 (HyperOS)",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Poco X6 Pro", "screen": "xhdpi 440dpi 1220x2712",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "oneplus_13": {
        "label": "OnePlus 13 / Android 15",
        "deviceType": "ANDROID", "osVersion": "Android 15",
        "deviceName": "OnePlus 13", "screen": "xxxhdpi 510dpi 1440x3168",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "oneplus_nord_5": {
        "label": "OnePlus Nord 5 / Android 15",
        "deviceType": "ANDROID", "osVersion": "Android 15",
        "deviceName": "OnePlus Nord 5", "screen": "xhdpi 450dpi 1272x2800",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "honor_magic6": {
        "label": "Honor Magic6 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Honor Magic6", "screen": "xxhdpi 460dpi 1200x2670",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "huawei_p60": {
        "label": "Huawei P60 / Android 12",
        "deviceType": "ANDROID", "osVersion": "Android 12",
        "deviceName": "Huawei P60", "screen": "xxhdpi 460dpi 1220x2700",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "oppo_reno12": {
        "label": "Oppo Reno 12 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Oppo Reno 12", "screen": "xhdpi 403dpi 1080x2412",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "vivo_x100": {
        "label": "Vivo X100 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Vivo X100", "screen": "xxhdpi 450dpi 1260x2800",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "realme_12_pro": {
        "label": "realme 12 Pro / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "realme 12 Pro", "screen": "xhdpi 401dpi 1080x2412",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "motorola_edge50": {
        "label": "Motorola Edge 50 / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Motorola Edge 50", "screen": "xhdpi 402dpi 1220x2712",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "nothing_phone_2a": {
        "label": "Nothing Phone (2a) / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Nothing Phone (2a)", "screen": "xhdpi 394dpi 1080x2412",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "sony_xperia_1_vi": {
        "label": "Sony Xperia 1 VI / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Sony Xperia 1 VI", "screen": "xxhdpi 460dpi 1080x2340",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
    "asus_zenfone_11": {
        "label": "Asus Zenfone 11 Ultra / Android 14",
        "deviceType": "ANDROID", "osVersion": "Android 14",
        "deviceName": "Asus Zenfone 11 Ultra", "screen": "xhdpi 395dpi 1080x2400",
        "arch": "arm64-v8a", "buildNumber": 6498,
    },
}
DEFAULT_DEVICE_PROFILE = "samsung_s23"


def get_device_profile_id() -> str:
    sess = load_session()
    pid = sess.get("deviceProfile", DEFAULT_DEVICE_PROFILE)
    if pid == "custom" and sess.get("customDeviceName"):
        return "custom"
    return pid if pid in DEVICE_PROFILES else DEFAULT_DEVICE_PROFILE


def set_device_profile_id(profile_id: str) -> bool:
    if profile_id not in DEVICE_PROFILES:
        return False
    sess = load_session()
    sess["deviceProfile"] = profile_id
    sess.pop("customDeviceName", None)
    save_session(sess)
    return True


def set_custom_device_name(device_name: str) -> bool:
    """Выбор устройства из полного каталога Google Play (не из нашего
    небольшого списка проверенных пресетов). Экран/архитектура/версия ОС
    для таких устройств не известны Google публично, поэтому берутся
    типовые значения из _GENERIC_SCREEN_POOL — сам сервер MAX ориентируется
    в первую очередь на deviceName, а не на точный dpi/разрешение."""
    device_name = (device_name or "").strip()
    if not device_name:
        return False
    sess = load_session()
    sess["deviceProfile"] = "custom"
    sess["customDeviceName"] = device_name
    save_session(sess)
    return True


def get_active_profile() -> dict:
    """Возвращает полный профиль (deviceType/osVersion/deviceName/screen/
    arch/buildNumber) для текущего выбора — либо один из проверенных
    пресетов DEVICE_PROFILES, либо кастомное устройство из каталога Google
    Play с типовыми значениями остальных полей."""
    sess = load_session()
    pid = sess.get("deviceProfile", DEFAULT_DEVICE_PROFILE)
    if pid == "custom" and sess.get("customDeviceName"):
        name = sess["customDeviceName"]
        screen = _GENERIC_SCREEN_POOL[hash(name) % len(_GENERIC_SCREEN_POOL)]
        return {
            "deviceType": "ANDROID",
            "osVersion": "Android 14",
            "deviceName": name,
            "screen": screen,
            "arch": "arm64-v8a",
            "buildNumber": 6498,
        }
    if pid not in DEVICE_PROFILES:
        pid = DEFAULT_DEVICE_PROFILE
    return DEVICE_PROFILES[pid]


def save_auth_token(token: str):
    sess = load_session()
    sess["authToken"] = token
    sess["authTime"] = int(time.time())
    save_session(sess)
    logger.info(f"[session] Auth token saved: {token[:20]}...")


def get_saved_auth_token():
    token = load_session().get("authToken")
    if token:
        logger.info(f"[session] Using saved auth token: {token[:20]}...")
    return token


def clear_auth_token():
    """Удаляет токен при ошибке авторизации"""
    sess = load_session()
    sess.pop("authToken", None)
    sess.pop("authTime", None)
    save_session(sess)
    logger.info("[session] Auth token cleared")


# --- Версия приложения ---
VERSION_CHECK_URL = "https://ru-oneme-app.en.uptodown.com/android"


def get_latest_app_version() -> str:
    sess = load_session()
    cached = sess.get("appVersionCache")
    if cached and time.time() - cached.get("checkedAt", 0) < VERSION_CACHE_HOURS * 3600:
        return cached.get("version", FALLBACK_APP_VERSION)
    try:
        req = urllib.request.Request(VERSION_CHECK_URL, headers={
                                     "User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        match = re.search(
            r"(\d{2}\.\d+\.\d+)\s*\W*Communication Platform LLC", html)
        version = match.group(1) if match else FALLBACK_APP_VERSION
        save_session(
            {**load_session(), "appVersionCache": {"version": version, "checkedAt": time.time()}})
        return version
    except Exception as e:
        logger.warning(f"[version] fetch failed, using fallback: {e}")
        return cached.get("version", FALLBACK_APP_VERSION) if cached else FALLBACK_APP_VERSION


# --- Декодирование ---
def _decode_bytes_deep(obj):
    if isinstance(obj, bytes):
        for enc in ("utf-8", "cp1251", "koi8-r", "iso-8859-5"):
            try:
                return obj.decode(enc)
            except UnicodeDecodeError:
                continue
        return obj.hex()
    if isinstance(obj, dict):
        return {_decode_bytes_deep(k): _decode_bytes_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decode_bytes_deep(v) for v in obj]
    return obj


_JS_SAFE_INT = 2 ** 53 - 1


def stringify_big_ints(obj):
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, int) and abs(obj) > _JS_SAFE_INT:
        return str(obj)
    if isinstance(obj, dict):
        return {k: stringify_big_ints(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [stringify_big_ints(v) for v in obj]
    return obj


def numify_big_int_strings(obj):
    if isinstance(obj, str) and re.fullmatch(r"-?\d+", obj) and abs(int(obj)) > _JS_SAFE_INT:
        return int(obj)
    if isinstance(obj, dict):
        return {k: numify_big_int_strings(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [numify_big_int_strings(v) for v in obj]
    return obj


# --- LZ4 ---
def _lz4_decompress_block(data: bytes) -> bytes:
    try:
        return lz4.block.decompress(data, uncompressed_size=2 * 1024 * 1024)
    except Exception:
        return lz4.block.decompress(data)


# --- Клиент MAX ---
class MaxClient:
    def __init__(self):
        self.sock = None
        self.seq = 0
        self.buf = b""
        self._connected = False
        self._lock = threading.Lock()

    def pack(self, opcode: int, payload: dict) -> bytes:
        self.seq = (self.seq + 1) % 256
        body = msgpack.packb(payload, use_bin_type=True)
        header = struct.pack(">BHBHI", 10, 0, self.seq, opcode, len(body))
        return header + body

    def send(self, opcode: int, payload: dict):
        pkt = self.pack(opcode, payload)
        with self._lock:
            self.sock.sendall(pkt)
        logger.debug(f"Sent: opcode={opcode}, seq={self.seq}")

    def _recv_exact_more(self):
        chunk = self.sock.recv(4096)
        if not chunk:
            raise ConnectionError("Connection closed")
        self.buf += chunk

    def recv_packet(self) -> dict:
        while len(self.buf) < 10:
            self._recv_exact_more()

        ver, cmd, seq, opcode, packed_len = struct.unpack(
            ">BHBHI", self.buf[:10])
        comp_flag = packed_len >> 24
        payload_len = packed_len & 0x00FFFFFF

        while len(self.buf) < 10 + payload_len:
            self._recv_exact_more()

        payload_bytes = self.buf[10:10 + payload_len]
        self.buf = self.buf[10 + payload_len:]

        payload = None
        if payload_bytes:
            try:
                data_to_parse = payload_bytes
                if comp_flag:
                    data_to_parse = _lz4_decompress_block(payload_bytes)
                parsed = msgpack.unpackb(
                    data_to_parse, raw=True, strict_map_key=False)
                payload = _decode_bytes_deep(parsed)
            except Exception as e:
                logger.debug(f"Unpack failed: {e}")
                payload = {"raw": payload_bytes.hex()}

        return {"ver": ver, "cmd": cmd, "seq": seq, "opcode": opcode, "payload": payload}

    def connect(self, existing_token: str = None):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((HOST, PORT), timeout=CONNECT_TIMEOUT)
        self.sock = ctx.wrap_socket(raw, server_hostname=HOST)
        self.sock.settimeout(TIMEOUT)
        self._connected = True
        self._send_handshake(existing_token)

    def _send_handshake(self, existing_token: str = None):
        profile = get_active_profile()
        payload = {
            "mt_instanceid": str(uuid.uuid4()),
            "clientSessionId": random.randint(1, 100),
            "deviceId": get_or_create_device_id(),
            "userAgent": {
                "deviceType": profile["deviceType"],
                "locale": "ru",
                "deviceLocale": "ru",
                "osVersion": profile["osVersion"],
                "deviceName": profile["deviceName"],
                "appVersion": get_latest_app_version(),
                "screen": profile["screen"],
                "timezone": "Europe/Moscow",
                "pushDeviceType": "GCM",
                "arch": profile["arch"],
                "buildNumber": profile["buildNumber"],
            },
        }
        if existing_token:
            payload["token"] = existing_token
            logger.info(
                f"[handshake] Using existing token: {existing_token[:20]}...")
        else:
            logger.info("[handshake] No existing token, starting fresh")

        self.send(6, payload)

    def close(self):
        self._connected = False
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass


# --- fetch_once ---
def fetch_once(opcode: int, payload: dict, wait_opcode: int, timeout: float = 15.0, use_token: bool = True):
    saved_token = get_saved_auth_token() if use_token else None
    client = MaxClient()
    client.connect(existing_token=saved_token)
    try:
        deadline = time.time() + timeout

        # Ждем успешного handshake
        handshake_ok = False
        handshake_response = None
        while time.time() < deadline and not handshake_ok:
            try:
                packet = client.recv_packet()
            except socket.timeout:
                continue
            if packet["opcode"] == 6:
                handshake_response = packet
                handshake_ok = packet["cmd"] == 256
                if handshake_ok:
                    logger.info("[fetch_once] Handshake successful")
                else:
                    logger.warning(
                        f"[fetch_once] handshake failed: cmd={packet['cmd']}, payload={packet.get('payload')!r}")
                    return packet

        if not handshake_ok:
            logger.warning("[fetch_once] handshake timeout")
            return None

        # Если это операция аутентификации, пропускаем sync
        # (20 — это logout, не имеет отношения к паролю; проверка пароля при
        # входе — отдельный опкод 115, см. Komet: Opcode.authLoginCheckPassword)
        if opcode in [17, 18, 115]:  # START_AUTH, CHECK_CODE, LOGIN_CHECK_PASSWORD
            logger.info(f"[fetch_once] Auth operation {opcode}, skipping sync")
        else:
            # Отправляем sync только для не-аутентификационных операций
            sync_payload = {"chatsSync": 0,
                            "contactsSync": 0, "interactive": True}
            if saved_token:
                sync_payload["token"] = saved_token
            client.send(19, sync_payload)

            sync_ok = False
            while time.time() < deadline and not sync_ok:
                try:
                    packet = client.recv_packet()
                except socket.timeout:
                    continue
                if packet["opcode"] == 19:
                    sync_ok = packet["cmd"] == 256
                    if not sync_ok:
                        logger.warning(
                            f"[fetch_once] online-sync failed: {packet.get('payload')!r}")
                        return packet
            if not sync_ok:
                logger.warning("[fetch_once] online-sync timeout")
                return None

        # Добавляем токен только если нужно
        if use_token and "token" not in payload and saved_token:
            payload["token"] = saved_token

        logger.info(
            f"[fetch_once] Sending opcode {opcode} with payload keys: {list(payload.keys())}")
        client.send(opcode, payload)

        # Ждем ответ
        while time.time() < deadline:
            try:
                packet = client.recv_packet()
            except socket.timeout:
                continue
            if packet["opcode"] == wait_opcode:
                return packet
            # Также обрабатываем другие ответы
            if packet["opcode"] == wait_opcode + 1 or packet["cmd"] == 768:
                return packet

        logger.warning(
            f"[fetch_once] Timeout waiting for opcode {wait_opcode}")
        return None
    finally:
        client.close()


# --- Загрузка файлов и фото ---
# MAX использует два разных опкода в зависимости от типа вложения:
#   87 (FILE_UPLOAD)  — произвольный файл: сервер сразу выдаёт fileId+token,
#                       само тело файла заливается POST'ом без multipart-
#                       обёртки (см. Komet: FileUploader.upload).
#   80 (PHOTO_UPLOAD) — фото: сервер выдаёт только URL, а токен для вложения
#                       возвращается в теле ответа (JSON) после multipart-
#                       загрузки (см. Komet: FileUploader.uploadPhoto).
# В обоих случаях бридж только заливает байты и возвращает token/fileId —
# само сообщение (opcode 64, MSG_SEND) отправляет фронтенд через уже
# открытый /relay, тем же путём, что и обычный текст.
_UPLOAD_MIME_MAP = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "gif": "image/gif", "webp": "image/webp", "heic": "image/heic",
    "heif": "image/heic", "bmp": "image/bmp",
}


def _mime_for_filename(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return _UPLOAD_MIME_MAP.get(ext, "application/octet-stream")


# --- Flask приложение ---
# Проверяем систему: если рядом с bridge.py есть папка static/ (десктоп-версия) —
# раздаём файлы из неё; если нет (Android-сборка, где index.html лежит прямо
# рядом с bridge.py) — раздаём файлы из папки самого bridge.py.
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_STATIC_CANDIDATE = os.path.join(_BASE_DIR, "static")
STATIC_DIR = _STATIC_CANDIDATE if os.path.isdir(
    _STATIC_CANDIDATE) else _BASE_DIR
logger.info(f"[static] Serving frontend files from: {STATIC_DIR}")

app = Flask(__name__, static_folder=STATIC_DIR)
sock = Sock(app)


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/lottie.min.js")
def serve_lottie_lib():
    """Раздаёт lottie-web из локального кэша (см. ensure_lottie_cached()).
    Если файла ещё нет (например, самый первый запуск — фоновое скачивание
    не успело) — пробуем скачать синхронно прямо сейчас; если и это не
    вышло (офлайн), отдаём 404 — фронтенд уже умеет работать без анимации."""
    if not os.path.exists(LOTTIE_CACHE_FILE):
        ensure_lottie_cached()
    if os.path.exists(LOTTIE_CACHE_FILE):
        return send_from_directory(
            os.path.dirname(LOTTIE_CACHE_FILE),
            os.path.basename(LOTTIE_CACHE_FILE),
            mimetype="application/javascript",
        )
    return ("", 404)


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/lottie")
def proxy_lottie():
    """Прокси для Lottie-JSON анимированных стикеров (fd.oneme.ru/getfile?rq=...).
    Нужен отдельно от /img, т.к. отдаёт JSON, а не картинку, и хост другой."""
    url = request.args.get("url", "")
    allowed_hosts = ("fd.oneme.ru",)

    if not url.startswith("https://"):
        return "", 400

    host = urllib.parse.urlparse(url).hostname or ""
    if not any(host == h or host.endswith(f".{h}") for h in allowed_hosts):
        return "", 400

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S911B)", "Referer": "https://web.max.ru/"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read()

        # Lottie-стикеры (как и Telegram .tgs) часто приходят gzip-сжатым JSON,
        # а не просто с Content-Encoding: gzip — распаковываем по магическим байтам.
        if data[:2] == b"\x1f\x8b":
            try:
                data = gzip.decompress(data)
            except Exception as e:
                logger.warning(
                    f"[lottie proxy] gzip decompress failed for {url}: {e}")
                return "", 502

        return Response(data, content_type="application/json", headers={"Cache-Control": "public, max-age=86400"})
    except Exception as e:
        logger.warning(f"[lottie proxy] failed for {url}: {e}")
        return "", 502


@app.route("/img")
def proxy_image():
    url = request.args.get("url", "")
    allowed_hosts = ("i.oneme.ru", "iv.okcdn.ru", "st.max.ru", "selcdn.net")

    if not url.startswith("https://"):
        return "", 400

    host = urllib.parse.urlparse(url).hostname or ""
    if not any(host == h or host.endswith(f".{h}") for h in allowed_hosts):
        return "", 400

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S911B)", "Referer": "https://web.max.ru/"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "image/jpeg")
        return Response(data, content_type=content_type, headers={"Cache-Control": "public, max-age=3600"})
    except Exception as e:
        logger.warning(f"[img proxy] failed for {url}: {e}")
        return "", 502


@app.route("/video")
def proxy_video():
    url = request.args.get("url", "")
    logger.info(f"[video proxy] Request for: {url}")

    if not url or not (url.startswith("https://") or url.startswith("http://")):
        logger.warning(f"[video proxy] Invalid URL: {url}")
        return "", 400

    range_header = request.headers.get("Range")
    req_headers = {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S911B)",
        "Referer": "https://web.max.ru/",
    }
    if range_header:
        req_headers["Range"] = range_header

    try:
        req = urllib.request.Request(url, headers=req_headers)
        upstream = urllib.request.urlopen(req, timeout=30)
        logger.info(f"[video proxy] Success, status: {upstream.status}")
    except urllib.error.HTTPError as e:
        logger.warning(f"[video proxy] HTTPError: {e}")
        return "", 502
    except Exception as e:
        logger.warning(f"[video proxy] failed: {e}")
        return "", 502

    status = upstream.status
    content_type = upstream.headers.get("Content-Type", "video/mp4")
    content_range = upstream.headers.get("Content-Range")
    content_length = upstream.headers.get("Content-Length")
    accept_ranges = upstream.headers.get("Accept-Ranges", "bytes")

    def generate():
        try:
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    out_headers = {"Accept-Ranges": accept_ranges,
                   "Cache-Control": "public, max-age=3600"}
    if content_range:
        out_headers["Content-Range"] = content_range
    if content_length:
        out_headers["Content-Length"] = content_length

    return Response(
        stream_with_context(generate()),
        status=status,
        content_type=content_type,
        headers=out_headers,
    )


@app.route("/api/start-auth", methods=["POST"])
def start_auth():
    """Начинает аутентификацию - запрос OTP"""
    data = request.get_json(force=True)
    phone = data.get("phone", "").strip().replace(r"[\s\-\(\)]", "")

    if not phone or phone == "+7":
        return jsonify({"error": "Укажите номер телефона"}), 400

    logger.info(f"[auth] Starting auth for {phone}")

    try:
        packet = fetch_once(
            17,
            {"phone": phone, "type": "START_AUTH"},
            wait_opcode=17,
            timeout=15,
            use_token=False
        )
    except Exception as e:
        logger.warning(f"[auth] Start auth failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet or packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Ошибка отправки кода") if packet else "Нет ответа"
        return jsonify({"error": error_msg}), 502

    # Сохраняем OTP токен
    otp_token = packet.get("payload", {}).get("token")
    if otp_token:
        sess = load_session()
        sess["otpToken"] = otp_token
        sess["phone"] = phone
        save_session(sess)
        logger.info(f"[auth] OTP token saved: {otp_token[:20]}...")

    return jsonify({"success": True, "message": "Код отправлен"})


@app.route("/api/verify-code", methods=["POST"])
def verify_code():
    """Подтверждает код и проверяет, нужен ли пароль"""
    data = request.get_json(force=True)
    code = data.get("code", "").strip()

    sess = load_session()
    otp_token = sess.get("otpToken")
    phone = sess.get("phone")

    if not code:
        return jsonify({"error": "Введите код"}), 400
    if not otp_token:
        return jsonify({"error": "Сначала запросите код"}), 400

    logger.info(f"[auth] Verifying code for {phone}")

    try:
        packet = fetch_once(
            18,
            {
                "token": otp_token,
                "verifyCode": code,
                "authTokenType": "CHECK_CODE",
                "phone": phone
            },
            wait_opcode=18,
            timeout=15,
            use_token=False
        )
    except Exception as e:
        logger.warning(f"[auth] Verify code failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet:
        return jsonify({"error": "Нет ответа от сервера"}), 502

    payload = packet.get("payload", {})

    # Проверяем, требует ли сервер пароль
    if payload.get("passwordChallenge"):
        challenge = payload["passwordChallenge"]
        logger.info(f"[auth] Password required. Hint: {challenge.get('hint')}")

        # Сохраняем данные для проверки пароля
        sess["passwordTrackId"] = challenge.get("trackId")
        sess["passwordHint"] = challenge.get("hint", "")
        sess["passwordEmail"] = challenge.get("email", "")
        save_session(sess)

        return jsonify({
            "needPassword": True,
            "hint": challenge.get("hint", ""),
            "email": challenge.get("email", ""),
            "trackId": challenge.get("trackId", "")
        })

    if packet["cmd"] != 256:
        error_msg = payload.get("localizedMessage", "Неверный код")
        return jsonify({"error": error_msg}), 502

    # Сохраняем основной токен (без пароля)
    token_attrs = payload.get("tokenAttrs", {})
    if "LOGIN" in token_attrs:
        new_token = token_attrs["LOGIN"].get("token")
        if new_token:
            save_auth_token(new_token)
            sess = load_session()
            sess.pop("otpToken", None)
            sess.pop("phone", None)
            save_session(sess)
            logger.info(
                f"[auth] Auth successful! Token saved: {new_token[:20]}...")
            return jsonify({"success": True, "message": "Авторизация успешна", "needPassword": False})

    auth_token = payload.get("authToken") or payload.get("token")
    if auth_token:
        save_auth_token(auth_token)
        sess = load_session()
        sess.pop("otpToken", None)
        sess.pop("phone", None)
        save_session(sess)
        logger.info(
            f"[auth] Auth token saved from payload: {auth_token[:20]}...")
        return jsonify({"success": True, "message": "Авторизация успешна", "needPassword": False})

    logger.warning(f"[auth] Unexpected response: {payload}")
    return jsonify({"error": "Неожиданный ответ сервера"}), 502


@app.route("/api/verify-password", methods=["POST"])
def verify_password():
    """Отправляет пароль для двухфакторной аутентификации.

    Опкод — 115 (authLoginCheckPassword в Komet), не 18 (это проверка
    OTP-кода) и не 20 (это logout). Payload минимальный — только trackId
    и password, без token/authTokenType/phone."""
    data = request.get_json(force=True)
    password = data.get("password", "").strip()

    sess = load_session()
    otp_token = sess.get("otpToken")
    phone = sess.get("phone")
    track_id = sess.get("passwordTrackId")

    if not password:
        return jsonify({"error": "Введите пароль"}), 400
    if not otp_token or not track_id:
        return jsonify({"error": "Сначала запросите код"}), 400

    logger.info(f"[auth] Verifying password for {phone}, trackId={track_id}")

    payload = {
        "trackId": track_id,
        "password": password,
    }

    try:
        packet = fetch_once(
            115,
            payload,
            wait_opcode=115,
            timeout=10,
            use_token=False,
        )
    except Exception as e:
        logger.warning(f"[auth] verify-password exception: {e}")
        return jsonify({"error": str(e)}), 502

    if not packet:
        return jsonify({"error": "Нет ответа от сервера"}), 502

    if packet.get("cmd") == 256:
        payload_data = packet.get("payload", {}) or {}

        token_attrs = payload_data.get("tokenAttrs", {})
        new_token = token_attrs.get("LOGIN", {}).get(
            "token") if isinstance(token_attrs, dict) else None
        if not new_token:
            new_token = payload_data.get(
                "authToken") or payload_data.get("token")

        if new_token:
            save_auth_token(new_token)

        sess = load_session()
        for key in ["otpToken", "phone", "passwordTrackId", "passwordHint", "passwordEmail"]:
            sess.pop(key, None)
        save_session(sess)

        logger.info(
            "[auth] Password check succeeded, token saved" if new_token else "[auth] Password check succeeded, no token in response")
        return jsonify({"success": True, "message": "Авторизация успешна"})

    if packet.get("cmd") == 768:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage") or packet.get("payload", {}).get("message", "")
        logger.warning(f"[auth] Password check failed: {error_msg}")

        if packet.get("payload", {}).get("passwordChallenge"):
            challenge = packet["payload"]["passwordChallenge"]
            sess["passwordTrackId"] = challenge.get("trackId")
            sess["passwordHint"] = challenge.get("hint", "")
            save_session(sess)

        return jsonify({"error": error_msg or "Неверный пароль"}), 400

    logger.warning(f"[auth] Password check: unexpected response {packet}")
    return jsonify({"error": "Не удалось подтвердить пароль"}), 502


@app.route("/api/resend-code", methods=["POST"])
def resend_code():
    """Повторно отправляет код подтверждения"""
    sess = load_session()
    phone = sess.get("phone")

    if not phone:
        return jsonify({"error": "Сначала запросите код"}), 400

    logger.info(f"[resend] Resending code to {phone}")

    try:
        packet = fetch_once(
            17,
            {"phone": phone, "type": "START_AUTH"},
            wait_opcode=17,
            timeout=15,
            use_token=False
        )
    except Exception as e:
        logger.warning(f"[resend] failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet or packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Не удалось отправить код") if packet else "Нет ответа"
        return jsonify({"error": error_msg}), 502

    otp_token = packet.get("payload", {}).get("token")
    if otp_token:
        sess["otpToken"] = otp_token
        save_session(sess)
        logger.info(f"[resend] New OTP token saved: {otp_token[:20]}...")

    return jsonify({"success": True, "message": "Код отправлен повторно"})


@app.route("/api/check-auth", methods=["GET"])
def check_auth():
    """Проверяет статус авторизации"""
    token = get_saved_auth_token()
    if token:
        return jsonify({"authenticated": True})
    return jsonify({"authenticated": False})


@app.route("/api/device-settings", methods=["GET"])
def get_device_settings():
    sess = load_session()
    return jsonify({
        "deviceId": get_or_create_device_id(),
        "profile": get_device_profile_id(),
        "profiles": {pid: p["label"] for pid, p in DEVICE_PROFILES.items()},
        "customDeviceName": sess.get("customDeviceName"),
        "catalogCount": len(load_device_catalog()),
    })


@app.route("/api/device-settings", methods=["POST"])
def set_device_settings():
    data = request.get_json(force=True) or {}
    profile_id = data.get("profile")
    custom_name = data.get("customDeviceName")
    if custom_name:
        if not set_custom_device_name(custom_name):
            return jsonify({"error": "invalid device name"}), 400
        return jsonify({"ok": True, "profile": "custom", "customDeviceName": custom_name})
    if not profile_id or not set_device_profile_id(profile_id):
        return jsonify({"error": "unknown profile"}), 400
    return jsonify({"ok": True, "profile": profile_id})


@app.route("/api/device-settings/regenerate", methods=["POST"])
def regenerate_device_settings():
    new_id = regenerate_device_id()
    logger.info(f"[device] deviceId regenerated: {new_id}")
    return jsonify({"ok": True, "deviceId": new_id})


@app.route("/api/device-catalog", methods=["GET"])
def get_device_catalog():
    """Поиск по полному (скачанному из интернета) каталогу устройств Google
    Play. ?q=строка фильтрует по подстроке (регистронезависимо), ?limit=
    ограничивает число результатов (по умолчанию 50 — каталог насчитывает
    десятки тысяч моделей, отдавать его целиком на каждый запрос смысла
    нет)."""
    catalog = load_device_catalog()
    q = (request.args.get("q") or "").strip().lower()
    try:
        limit = min(int(request.args.get("limit", 50)), 200)
    except ValueError:
        limit = 50
    if q:
        matches = [name for name in catalog if q in name.lower()]
    else:
        matches = catalog
    return jsonify({
        "total": len(catalog),
        "matches": matches[:limit],
        "matchCount": len(matches),
        "ready": len(catalog) > 0,
    })


@app.route("/api/device-catalog/refresh", methods=["POST"])
def refresh_device_catalog():
    """Принудительно перекачивает каталог устройств с сайта Google, не
    дожидаясь недельного авто-обновления. Запускается в фоне, чтобы не
    держать HTTP-запрос открытым на всё время скачивания CSV."""
    threading.Thread(target=lambda: ensure_device_catalog_cached(
        force=True), daemon=True).start()
    return jsonify({"ok": True, "refreshing": True})


@app.route("/api/scam-check/settings", methods=["GET"])
def get_scam_check_settings():
    return jsonify(_get_scam_check_settings())


@app.route("/api/scam-check/settings", methods=["POST"])
def set_scam_check_settings():
    data = request.get_json(force=True) or {}
    cfg = _save_scam_check_settings({
        "enabled": data.get("enabled"),
        "url": (data.get("url") or "").strip() or None,
        "model": (data.get("model") or "").strip() or None,
        "hfToken": data.get("hfToken") if "hfToken" in data else None,
    })
    if cfg.get("enabled") and _android_context is not None and not os.path.exists(GEMMA_MODEL_FILE):
        threading.Thread(target=ensure_gemma_model_cached, daemon=True).start()
    return jsonify({"ok": True, **cfg, "onDevice": _android_context is not None})


@app.route("/api/scam-check/model-status", methods=["GET"])
def scam_check_model_status():
    """Фронт опрашивает это, пока показывает прогресс-бар скачивания."""
    return jsonify({
        "onDeviceSupported": _android_context is not None,
        "modelReady": os.path.exists(GEMMA_MODEL_FILE),
        "llmInitError": _llm_init_error,
        **_model_download_state,
    })


@app.route("/api/scam-check/model", methods=["DELETE"])
def scam_check_delete_model():
    """Удаляет скачанную on-device модель с диска (кнопка в настройках)."""
    removed = delete_gemma_model()
    return jsonify({"ok": True, "removed": removed})


@app.route("/api/scam-check/model/redownload", methods=["POST"])
def scam_check_redownload_model():
    """Повторно запускает скачивание — например, после того как пользователь
    вписал HF-токен и хочет исправить прошлую ошибку 401."""
    if _android_context is None:
        return jsonify({"error": "not on Android"}), 400
    if os.path.exists(GEMMA_MODEL_FILE):
        return jsonify({"ok": True, "alreadyReady": True})
    threading.Thread(target=ensure_gemma_model_cached, daemon=True).start()
    return jsonify({"ok": True, "started": True})


def _run_scam_check(text: str) -> dict:
    """Общая логика: on-device -> fallback на внешний сервер. Используется и
    одиночным роутом /api/scam-check, и массовым сканером всех чатов
    (scan_all_cached_chats). Кидает исключение при полном отказе (обе ветки
    недоступны/сломаны) — вызывающий код сам решает, что делать с ошибкой."""
    cfg = _get_scam_check_settings()
    if not cfg["enabled"]:
        raise RuntimeError("disabled")
    text = (text or "").strip()[:2000]
    if not text:
        raise RuntimeError("empty text")

    llm = get_on_device_llm()
    on_device_status = (
        "ready" if llm is not None else
        ("no_android_context" if _android_context is None else
         ("model_not_downloaded" if not os.path.exists(GEMMA_MODEL_FILE) else "init_failed"))
    )
    on_device_error = _llm_init_error if on_device_status == "init_failed" else None
    if llm is not None:
        try:
            prompt = SCAM_CHECK_SYSTEM_PROMPT + "\n\nСообщение:\n" + text
            content = llm.generateResponse(prompt)
            verdict = _parse_scam_verdict_text(content)
            return {**verdict, "engine": "on-device",
                    "onDeviceStatus": "ready", "onDeviceError": None}
        except Exception as e:
            on_device_error = str(e)
            on_device_status = "inference_failed"
            logger.warning(
                f"[scam-check] on-device inference failed, falling back: {e}")

    debug_info = {"onDeviceStatus": on_device_status,
                  "onDeviceError": on_device_error}

    body = json.dumps({
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SCAM_CHECK_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "temperature": 0,
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg["url"], data=body,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=SCAM_CHECK_TIMEOUT) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    content = raw["choices"][0]["message"]["content"]
    verdict = _parse_scam_verdict_text(content)
    return {**verdict, "engine": "external", **debug_info}


@app.route("/api/scam-check", methods=["POST"])
def scam_check():
    """Прогоняет текст ОДНОГО сообщения через ИИ и возвращает вердикт (см.
    _run_scam_check). Приоритет: on-device -> fallback на внешний сервер."""
    data = request.get_json(force=True) or {}
    text = (data.get("text") or "").strip()
    logger.info(f"[scam-check] request received, text_len={len(text)}")
    if not text:
        return jsonify({"error": "empty text"}), 400
    try:
        result = _run_scam_check(text)
        logger.info(f"[scam-check] result: {result}")
        return jsonify(result)
    except RuntimeError as e:
        if str(e) == "disabled":
            return jsonify({"error": "disabled"}), 400
        return jsonify({"error": str(e)}), 400
    except urllib.error.URLError as e:
        return jsonify({
            "error": "no engine available (on-device model not ready, external server unreachable)",
            "details": str(e),
        }), 502
    except (KeyError, IndexError, TypeError) as e:
        return jsonify({"error": f"unexpected response from external server: {e}"}), 502
    except json.JSONDecodeError as e:
        return jsonify({"error": f"model did not return valid JSON: {e}"}), 502
    except Exception as e:
        logger.warning(f"[scam-check] unexpected error: {e}")
        return jsonify({"error": str(e)}), 502


# --- Массовая проверка всех сохранённых (закэшированных) чатов ---
# Ручная кнопка "Проверить все чаты" в настройках: идёт по messages_cache.json
# (последние MESSAGES_CACHE_LIMIT сообщений на каждый чат, которые и так уже
# лежат на диске для офлайн-режима — см. load_messages_cache/load_chats_cache
# выше), прогоняет каждое чужое сообщение через _run_scam_check и копит
# результаты. Работает в фоновом потоке с прогрессом (тот же паттерн, что у
# скачивания модели), т.к. может быть много сообщений и каждая проверка —
# не мгновенная (особенно on-device на слабом телефоне).
_scan_state = {
    "running": False,
    "checked": 0,
    "total": 0,
    # [{chatId, chatName, msgId, text, confidence, reason, engine}]
    "flagged": [],
    "error": None,
    "finishedAt": None,
}
_scan_lock = threading.Lock()


def scan_all_cached_chats(self_id=None, chat_id_filter=None):
    """Сканирует закэшированные сообщения. Если chat_id_filter задан —
    только этот чат (кнопка «Проверить чат на скам» в профиле чата),
    иначе — все закэшированные чаты сразу."""
    global _scan_state
    with _scan_lock:
        if _scan_state["running"]:
            return
        _scan_state = {"running": True, "checked": 0, "total": 0,
                       "flagged": [], "error": None, "finishedAt": None}

    try:
        chats_cache = load_chats_cache() or {}
        chats_by_id = {str(c.get("id")): c for c in (
            chats_cache.get("chats") or [])}
        messages_cache = load_messages_cache() or {}

        # Собираем плоский список (chatId, message) для всех чужих сообщений
        # с текстом — свои (self_id) пропускаем, как и на фронте.
        jobs = []
        for chat_id, entry in messages_cache.items():
            if chat_id_filter is not None and str(chat_id) != str(chat_id_filter):
                continue
            for m in (entry.get("messages") or []):
                text = (m.get("text") or "").strip()
                if not text:
                    continue
                if self_id is not None and str(m.get("sender")) == str(self_id):
                    continue
                jobs.append((chat_id, m))

        _scan_state["total"] = len(jobs)
        logger.info(f"[scam-check][scan-all] starting, {len(jobs)} messages "
                    f"(chat_id_filter={chat_id_filter}) across {len(messages_cache)} cached chats")

        for chat_id, m in jobs:
            try:
                result = _run_scam_check(m.get("text", ""))
                if result.get("is_scam"):
                    chat = chats_by_id.get(str(chat_id))
                    chat_name = (chat.get("title")
                                 if chat else None) or f"Чат #{chat_id}"
                    _scan_state["flagged"].append({
                        "chatId": chat_id,
                        "chatName": chat_name,
                        "msgId": m.get("id"),
                        "text": m.get("text", "")[:300],
                        "confidence": result.get("confidence"),
                        "reason": result.get("reason", ""),
                        "engine": result.get("engine"),
                    })
            except Exception as e:
                logger.warning(
                    f"[scam-check][scan-all] failed on message in chat {chat_id}: {e}")
            finally:
                _scan_state["checked"] += 1

        _scan_state["flagged"].sort(
            key=lambda f: f.get("confidence") or 0, reverse=True)
        logger.info(f"[scam-check][scan-all] done: {_scan_state['checked']} checked, "
                    f"{len(_scan_state['flagged'])} flagged")
    except Exception as e:
        logger.warning(f"[scam-check][scan-all] fatal error: {e}")
        _scan_state["error"] = str(e)
    finally:
        _scan_state["running"] = False
        _scan_state["finishedAt"] = int(time.time() * 1000)


@app.route("/api/scam-check/scan-all", methods=["POST"])
def scam_check_scan_all():
    cfg = _get_scam_check_settings()
    if not cfg["enabled"]:
        return jsonify({"error": "disabled"}), 400
    if _scan_state["running"]:
        return jsonify({"error": "already running"}), 409
    data = request.get_json(force=True, silent=True) or {}
    self_id = data.get("selfId")
    # если задан — сканируем только этот чат
    chat_id_filter = data.get("chatId")
    threading.Thread(target=scan_all_cached_chats,
                     args=(self_id, chat_id_filter), daemon=True).start()
    return jsonify({"ok": True, "started": True})


@app.route("/api/scam-check/scan-all/status", methods=["GET"])
def scam_check_scan_all_status():
    return jsonify(_scan_state)


@app.route("/api/chats-cache", methods=["GET"])
def get_chats_cache():
    """Отдаёт последний сохранённый на диск список чатов для офлайн-режима."""
    cache = load_chats_cache()
    if cache is None:
        return jsonify({"success": False})
    return jsonify({"success": True, "data": cache})


@app.route("/api/chats-cache", methods=["POST"])
def post_chats_cache():
    """Сохраняет присланный список чатов на диск (для показа офлайн)."""
    payload = request.get_json(force=True, silent=True) or {}
    save_chats_cache(payload)
    return jsonify({"success": True})


@app.route("/api/messages-cache", methods=["GET"])
def get_messages_cache():
    """Отдаёт последние сохранённые сообщения одного чата (для офлайн-режима).
    ?chatId= обязателен."""
    chat_id = request.args.get("chatId", "")
    if not chat_id:
        return jsonify({"success": False, "error": "chatId required"}), 400
    cache = load_messages_cache()
    entry = cache.get(chat_id)
    if entry is None:
        return jsonify({"success": False})
    return jsonify({"success": True, "data": entry})


@app.route("/api/messages-cache", methods=["POST"])
def post_messages_cache():
    """Сохраняет последние сообщения одного чата на диск (не более
    MESSAGES_CACHE_LIMIT штук — самые свежие по полю time)."""
    payload = request.get_json(force=True, silent=True) or {}
    chat_id = str(payload.get("chatId", ""))
    messages = payload.get("messages")
    if not chat_id or not isinstance(messages, list):
        return jsonify({"success": False, "error": "chatId and messages required"}), 400

    trimmed = sorted(messages, key=lambda m: m.get(
        "time", 0))[-MESSAGES_CACHE_LIMIT:]

    cache = load_messages_cache()
    cache[chat_id] = {"messages": trimmed, "savedAt": int(time.time() * 1000)}
    save_messages_cache(cache)
    return jsonify({"success": True})


@app.route("/api/logout", methods=["POST"])
def logout():
    """Выход из аккаунта"""
    clear_auth_token()
    return jsonify({"success": True, "message": "Вы вышли из аккаунта"})


@app.route("/api/video-url", methods=["GET"])
def video_url():
    """Получает прямой URL видео по videoId и token"""
    video_id = request.args.get("videoId")
    token = request.args.get("token")

    if not video_id or not token:
        return jsonify({"error": "Missing videoId or token"}), 400

    logger.info(f"[video-url] Getting video for id={video_id}")

    try:
        packet = fetch_once(
            83,
            {
                "messageId": 0,
                "chatId": 0,
                "token": token,
                "videoId": int(video_id),
            },
            wait_opcode=83,
            timeout=15
        )
    except Exception as e:
        logger.warning(f"[video-url] failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet or packet["cmd"] != 256:
        logger.warning(f"[video-url] no response, packet: {packet}")
        return jsonify({"error": "No response from MAX"}), 502

    payload = packet.get("payload", {})

    video_url = None
    quality_map = {
        "MP4_1080": "1080p",
        "MP4_720": "720p",
        "MP4_480": "480p",
        "MP4_360": "360p",
        "MP4_240": "240p",
        "MP4_144": "144p"
    }

    for key in quality_map.keys():
        if payload.get(key):
            video_url = payload[key]
            break

    if not video_url and payload.get("HLS"):
        video_url = payload.get("HLS")

    if not video_url and payload.get("EXTERNAL"):
        video_url = payload.get("EXTERNAL")

    if not video_url:
        return jsonify({"error": "No video URL found"}), 404

    return jsonify({"url": video_url})


@app.route("/api/video-sources", methods=["POST"])
def video_sources():
    data = request.get_json(force=True)
    try:
        packet = fetch_once(
            83,
            {
                "messageId": int(data.get("messageId") or 0),
                "chatId": int(data["chatId"]),
                "token": data["token"],
                "videoId": int(data["videoId"]),
            },
            wait_opcode=83,
        )
    except Exception as e:
        logger.warning(f"[video-sources] failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet:
        return jsonify({"sources": {}, "error": "timeout"})

    if packet["cmd"] != 256:
        return jsonify({"sources": {}, "error": f"cmd={packet['cmd']}"})

    if not isinstance(packet.get("payload"), dict):
        return jsonify({"sources": {}})

    mp4_keys = {
        "MP4_1080": "1080p",
        "MP4_720": "720p",
        "MP4_480": "480p",
        "MP4_360": "360p",
        "MP4_240": "240p",
        "MP4_144": "144p",
    }
    payload = packet["payload"]
    sources = {label: payload[key]
               for key, label in mp4_keys.items() if payload.get(key)}

    if not sources:
        hls = payload.get("HLS")
        if hls:
            sources["Авто (HLS)"] = hls
        external = payload.get("EXTERNAL")
        if external:
            sources["Источник"] = external

    return jsonify({"sources": sources})


@app.route("/api/web-app-init", methods=["POST"])
def web_app_init():
    """Получает signed URL мини-приложения (opcode 160, WEB_APP_INIT_DATA)."""
    data = request.get_json(force=True)
    bot_id = data.get("botId")
    if bot_id is None:
        return jsonify({"error": "botId обязателен"}), 400

    payload = {"botId": int(bot_id)}
    start_param = data.get("startParam")
    if start_param:
        payload["startParam"] = start_param
    chat_id = data.get("chatId")
    if chat_id is not None:
        payload["chatId"] = int(chat_id)

    logger.info(
        f"[web-app-init] botId={bot_id}, chatId={chat_id}, startParam={start_param!r}")

    try:
        packet = fetch_once(160, payload, wait_opcode=160, timeout=15)
    except Exception as e:
        logger.warning(f"[web-app-init] failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet:
        return jsonify({"error": "Нет ответа от сервера"}), 502

    if packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Не удалось открыть мини-приложение")
        return jsonify({"error": error_msg}), 502

    url = packet.get("payload", {}).get("url") if isinstance(
        packet.get("payload"), dict) else None
    if not url:
        return jsonify({"error": "Сервер не вернул адрес приложения"}), 502

    return jsonify({"url": url})


@app.route("/api/button-callback", methods=["POST"])
def button_callback():
    """Отправляет нажатие inline-кнопки боту (opcode 118, MSG_SEND_CALLBACK)."""
    data = request.get_json(force=True)
    chat_id = data.get("chatId")
    message_id = data.get("messageId")
    callback_id = data.get("callbackId")

    if chat_id is None or message_id is None or not callback_id:
        return jsonify({"error": "chatId, messageId и callbackId обязательны"}), 400

    payload = {
        "chatId": int(chat_id),
        "messageId": int(message_id),
        "callbackId": callback_id,
    }
    btn_payload = data.get("payload")
    if btn_payload is not None and btn_payload != "":
        payload["payload"] = btn_payload

    logger.info(
        f"[button-callback] chatId={chat_id}, messageId={message_id}, callbackId={callback_id!r}")

    try:
        packet = fetch_once(118, payload, wait_opcode=118, timeout=15)
    except Exception as e:
        logger.warning(f"[button-callback] failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet:
        return jsonify({"error": "Нет ответа от сервера"}), 502

    if packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Не удалось отправить нажатие кнопки")
        return jsonify({"error": error_msg}), 502

    answer = packet.get("payload")
    if isinstance(answer, dict):
        return jsonify(answer)
    return jsonify({})


@app.route("/api/file-url", methods=["POST"])
def get_file_url():
    """Актуальная (подписанная, со сроком действия) ссылка на файл-вложение.
    Собрать её на клиенте из token нельзя — не хватает r=/expires=, сервер сам
    выдаёт готовый URL по fileId/chatId/messageId через opcode 88."""
    data = request.get_json(force=True)
    file_id = data.get("fileId")
    chat_id = data.get("chatId")
    message_id = data.get("messageId")

    if file_id is None or chat_id is None or message_id is None:
        return jsonify({"error": "fileId, chatId и messageId обязательны"}), 400

    payload = {
        "fileId": int(file_id),
        "chatId": int(chat_id),
        "messageId": int(message_id),
    }

    try:
        packet = fetch_once(88, payload, wait_opcode=88, timeout=15)
    except Exception as e:
        logger.warning(f"[file-url] failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet:
        return jsonify({"error": "Нет ответа от сервера"}), 502

    if packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Не удалось получить ссылку на файл")
        return jsonify({"error": error_msg}), 502

    url = packet.get("payload", {}).get("url") if isinstance(
        packet.get("payload"), dict) else None
    if not url:
        return jsonify({"error": "Сервер не вернул ссылку на файл"}), 502

    return jsonify({"url": url})


@app.route("/api/download", methods=["POST"])
def download_file():
    data = request.get_json(force=True)
    url = data.get("url")
    token = data.get("token")
    filename = data.get("filename") or "file"
    if not url or not token:
        return "", 400

    try:
        packet = fetch_once(88, {"url": url, "token": token}, wait_opcode=88)
    except Exception as e:
        logger.warning(f"[download] failed: {e}")
        return "", 500

    if not packet or packet["cmd"] != 256 or not isinstance(packet.get("payload"), dict):
        return "", 502

    content = packet["payload"].get("content")
    if not isinstance(content, str):
        return "", 502

    try:
        raw_bytes = bytes.fromhex(content)
    except ValueError:
        raw_bytes = content.encode("utf-8", errors="ignore")

    return Response(
        raw_bytes,
        mimetype="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.route("/api/upload-file", methods=["POST"])
def upload_file():
    """Загружает произвольный файл (opcode 87, FILE_UPLOAD).

    Ожидает multipart/form-data с полем "file". Возвращает fileId/token —
    их нужно вставить в attaches сообщения как
    {"_type": "FILE", "token": token} и отправить через /relay (opcode 64),
    как обычное текстовое сообщение.
    """
    f = request.files.get("file")
    if f is None:
        return jsonify({"error": "Файл не передан"}), 400

    filename = f.filename or "file"
    data = f.read()
    total = len(data)
    if total == 0:
        return jsonify({"error": "Пустой файл"}), 400

    try:
        packet = fetch_once(87, {"count": 1}, wait_opcode=87, timeout=20)
    except Exception as e:
        logger.warning(f"[upload-file] fileUpload request failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet or packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Не удалось получить ссылку для загрузки") if packet else "Нет ответа от сервера"
        return jsonify({"error": error_msg}), 502

    info_list = (packet.get("payload") or {}).get("info") or []
    if not info_list:
        return jsonify({"error": "Сервер не вернул данные для загрузки"}), 502

    info = info_list[0]
    upload_url = info.get("url")
    file_id = info.get("fileId")
    token = info.get("token")
    if not upload_url:
        return jsonify({"error": "Сервер не вернул URL загрузки"}), 502

    try:
        req = urllib.request.Request(
            upload_url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "application/x-binary; charset=x-user-defined",
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Range": f"bytes 0-{total - 1}/{total}",
                "Content-Length": str(total),
                "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S911B)",
            },
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        logger.warning(f"[upload-file] upload HTTP error: {e}")
        return jsonify({"error": f"Ошибка загрузки: HTTP {e.code}"}), 502
    except Exception as e:
        logger.warning(f"[upload-file] upload failed: {e}")
        return jsonify({"error": str(e)}), 502

    if status != 200:
        return jsonify({"error": f"Ошибка загрузки: HTTP {status}"}), 502

    logger.info(
        f"[upload-file] Uploaded {filename} ({total} bytes), fileId={file_id}")
    return jsonify({
        "success": True,
        "fileId": file_id,
        "token": token,
        "name": filename,
        "size": total,
    })


@app.route("/api/upload-photo", methods=["POST"])
def upload_photo():
    """Загружает фото (opcode 80, PHOTO_UPLOAD).

    Ожидает multipart/form-data с полем "file". Возвращает photoToken —
    его нужно вставить в attaches сообщения как
    {"_type": "PHOTO", "photoToken": token} и отправить через /relay
    (opcode 64), как обычное текстовое сообщение.
    """
    f = request.files.get("file")
    if f is None:
        return jsonify({"error": "Файл не передан"}), 400

    filename = f.filename or "photo.jpg"
    data = f.read()
    if not data:
        return jsonify({"error": "Пустой файл"}), 400

    try:
        packet = fetch_once(80, {"count": 1}, wait_opcode=80, timeout=20)
    except Exception as e:
        logger.warning(f"[upload-photo] photoUpload request failed: {e}")
        return jsonify({"error": str(e)}), 500

    if not packet or packet["cmd"] != 256:
        error_msg = packet.get("payload", {}).get(
            "localizedMessage", "Не удалось получить ссылку для загрузки фото") if packet else "Нет ответа от сервера"
        return jsonify({"error": error_msg}), 502

    upload_url = (packet.get("payload") or {}).get("url")
    if not upload_url:
        return jsonify({"error": "Сервер не вернул URL загрузки фото"}), 502

    boundary = f"----MaxClientBoundary{uuid.uuid4().hex}"
    content_type = _mime_for_filename(filename)
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")

    resp_body = ""
    try:
        req = urllib.request.Request(
            upload_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
                "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S911B)",
            },
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            resp_body = resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        try:
            resp_body = e.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        logger.warning(
            f"[upload-photo] upload HTTP error: {e}, body={resp_body[:200]}")
        return jsonify({"error": f"Ошибка загрузки: HTTP {e.code}"}), 502
    except Exception as e:
        logger.warning(f"[upload-photo] upload failed: {e}")
        return jsonify({"error": str(e)}), 502

    if status != 200:
        return jsonify({"error": f"Ошибка загрузки: HTTP {status}"}), 502

    photo_token = None
    try:
        parsed = json.loads(resp_body)
        if isinstance(parsed, dict):
            photos = parsed.get("photos")
            if isinstance(photos, dict):
                for v in photos.values():
                    if isinstance(v, dict) and v.get("token"):
                        photo_token = v["token"]
                        break
            if not photo_token:
                photo_token = parsed.get("photoToken")
    except Exception as e:
        logger.warning(
            f"[upload-photo] failed to parse response: {e}, body={resp_body[:200]}")

    if not photo_token:
        return jsonify({"error": "Сервер не вернул photoToken"}), 502

    logger.info(f"[upload-photo] Uploaded {filename} ({len(data)} bytes)")
    return jsonify({"success": True, "photoToken": photo_token, "name": filename})


def _connect_with_timeout(client: "MaxClient", existing_token, timeout: float):
    """Подключается к серверу MAX в отдельном потоке с жёстким таймаутом.

    socket.create_connection(timeout=...) ограничивает только сам TCP-connect,
    а не DNS-резолвинг перед ним — если интернета вообще нет, getaddrinfo()
    иногда всё равно виснет намного дольше. Поэтому запускаем connect() в
    отдельном потоке и не ждём его дольше timeout секунд: если не успел —
    считаем, что сети нет, и отдаём управление обратно (сам поток-неудачник
    просто умрёт демоном, когда/если ОС всё-таки вернёт ошибку).
    """
    result = {}

    def _worker():
        try:
            client.connect(existing_token=existing_token)
            result["ok"] = True
        except Exception as e:
            result["error"] = e

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(
            "Нет ответа от сервера — проверьте подключение к интернету")
    if "error" in result:
        raise result["error"]


@sock.route("/relay")
def relay(ws):
    saved_token = get_saved_auth_token()
    client = MaxClient()
    out_queue = queue.Queue()
    stop_event = threading.Event()

    try:
        _connect_with_timeout(client, saved_token, CONNECT_TIMEOUT)
    except Exception as e:
        ws.send(json.dumps(
            {"error": "Connection failed", "details": str(e), "offline": True}))
        # Явно закрываем WS корректным close-фреймом вместо того, чтобы
        # просто return'ить и полагаться на implicit-закрытие в flask-sock —
        # так браузер получает чистый close вместо "Invalid frame header".
        try:
            ws.close(reason=1000, message="offline")
        except Exception:
            pass
        return

    t = threading.Thread(target=recv_loop, args=(
        client, out_queue, stop_event), daemon=True)
    t.start()

    ws.send(json.dumps(
        {"type": "connected", "message": "Connected to MAX server"}))

    if saved_token:
        ws.send(json.dumps({
            "type": "session_restored",
            "message": "Используется сохранённая сессия"
        }))
        logger.info("[relay] Session restored with saved token")
    else:
        logger.info("[relay] New session, no saved token")
        ws.send(json.dumps({
            "type": "auth_required",
            "message": "Требуется авторизация"
        }))

    try:
        while True:
            try:
                while True:
                    packet = out_queue.get_nowait()
                    ws.send(json.dumps(stringify_big_ints(packet)))
            except queue.Empty:
                pass

            msg = ws.receive(timeout=0.2)
            if msg is None:
                continue

            req = json.loads(msg)
            opcode = req.get("opcode")
            payload = numify_big_int_strings(req.get("payload", {}))

            if "token" not in payload:
                current_token = get_saved_auth_token()
                if current_token:
                    payload["token"] = current_token

            if opcode == 0:
                ws.send(json.dumps({"opcode": 0, "payload": {"pong": True}}))
                continue

            # opcode 50 = chatMark (READ_MESSAGE и т.п.). Клиент теперь сам
            # подменяет temp_... id на ближайший подтверждённый перед
            # отправкой, но это подстраховка на стороне бриджа: если
            # messageId всё же не число (например старая версия клиента
            # или гонка состояний), сервер MAX либо отклонит такой пакет,
            # либо молча его проигнорирует — а клиент при этом уже считает
            # чат прочитанным локально. Поэтому не форвардим такой запрос
            # вообще и явно логируем это, чтобы баг было видно в логах
            # бриджа, а не терялся молча где-то в протоколе MAX.
            if opcode == 50:
                msg_id = payload.get("messageId")
                if msg_id is not None and not isinstance(msg_id, int):
                    logger.warning(
                        f"[relay] Skipped chatMark: non-numeric messageId "
                        f"{msg_id!r} (chatId={payload.get('chatId')}) — "
                        f"похоже на непорезолвленный temp_ id"
                    )
                    continue

            if opcode is not None:
                client.send(opcode, payload)

    except Exception as e:
        logger.info(f"Connection closed: {e}")
    finally:
        stop_event.set()
        client.close()


def recv_loop(client: MaxClient, out_queue: queue.Queue, stop_event: threading.Event):
    while not stop_event.is_set():
        try:
            packet = client.recv_packet()
        except socket.timeout:
            continue
        except (ConnectionError, OSError) as e:
            logger.warning(f"recv_loop stopped: {e}")
            break

        cmd_status = "OK" if packet["cmd"] == 256 else "ERROR" if packet["cmd"] == 768 else str(
            packet["cmd"])
        logger.info(
            f"RECEIVED: opcode={packet['opcode']}, cmd={packet['cmd']} ({cmd_status})")
        if packet["cmd"] == 768:
            logger.info(f"  error payload: {packet.get('payload')!r}")
        if packet["cmd"] == 256 and packet["opcode"] in (46, 60, 89):
            logger.info(
                f"  payload: {json.dumps(packet.get('payload'), ensure_ascii=False, indent=2)}")

        # Обработка ошибки авторизации
        if packet["opcode"] == 19 and packet["cmd"] == 768:
            error_msg = packet.get("payload", {}).get("localizedMessage", "")
            if any(word in error_msg.lower() for word in ["авториз", "authoriz", "login", "вход"]):
                logger.warning("[session] Auth token expired or invalid")
                clear_auth_token()
                packet["_auth_error"] = True

        # Сохраняем токен при успешной аутентификации (opcode 18)
        if packet["opcode"] == 18 and packet["cmd"] == 256 and packet.get("payload"):
            payload = packet["payload"]

            # Проверяем, есть ли passwordChallenge (значит пароль еще нужен)
            if payload.get("passwordChallenge"):
                logger.info("[session] Server requests password")
                # Не сохраняем токен, передаем challenge клиенту
            else:
                # Сохраняем токен
                token_attrs = payload.get("tokenAttrs")
                if token_attrs and "LOGIN" in token_attrs:
                    new_token = token_attrs["LOGIN"]["token"]
                    save_auth_token(new_token)
                    logger.info(
                        f"[session] Auth token saved: {new_token[:20]}...")
                else:
                    auth_token = payload.get(
                        "authToken") or payload.get("token")
                    if auth_token:
                        save_auth_token(auth_token)
                        logger.info(
                            f"[session] Auth token saved from alt field: {auth_token[:20]}...")
            # Проверяем tokenAttrs
            token_attrs = payload.get("tokenAttrs")
            if token_attrs and "LOGIN" in token_attrs:
                new_token = token_attrs["LOGIN"].get("token")
                if new_token:
                    save_auth_token(new_token)
                    logger.info(
                        f"[session] Auth token saved: {new_token[:20]}...")

            # Проверяем другие поля
            auth_token = payload.get("authToken") or payload.get("token")
            if auth_token and not token_attrs:
                save_auth_token(auth_token)
                logger.info(
                    f"[session] Auth token saved from alt field: {auth_token[:20]}...")

        out_queue.put(packet)


if __name__ == "__main__":
    debug_mode = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    port = int(os.getenv("PORT", "8080"))
    host = os.getenv("HOST", "0.0.0.0")
    logger.info(f"Starting server on {host}:{port}, debug={debug_mode}")
    app.run(host=host, port=port, debug=debug_mode)
