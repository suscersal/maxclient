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

import msgpack
from flask import Flask, send_from_directory, request, jsonify, Response, stream_with_context
from flask_sock import Sock
import lz4.block
import urllib.request
import urllib.error
import urllib.parse
import base64
import hashlib

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
VERSION_CACHE_HOURS = 24
FALLBACK_APP_VERSION = "26.15.0"
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
        payload = {
            "mt_instanceid": str(uuid.uuid4()),
            "clientSessionId": random.randint(1, 100),
            "deviceId": get_or_create_device_id(),
            "userAgent": {
                "deviceType": "ANDROID",
                "locale": "ru",
                "deviceLocale": "ru",
                "osVersion": "Android 14",
                "deviceName": "Samsung Galaxy S23",
                "appVersion": get_latest_app_version(),
                "screen": "xxhdpi 480dpi 1080x2340",
                "timezone": "Europe/Moscow",
                "pushDeviceType": "GCM",
                "arch": "arm64-v8a",
                "buildNumber": 6498,
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
