import json
import logging
import os
import queue
import random
import re
import socket
import ssl
import struct
import threading
import time
import uuid

import msgpack
from flask import Flask, send_from_directory
from flask_sock import Sock

# Для LZ4 (установить: pip install lz4)
import lz4.block

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

# --- Конфигурация из переменных окружения ---
HOST = os.getenv("MAX_HOST", "api.oneme.ru")
PORT = int(os.getenv("MAX_PORT", "443"))
SESSION_FILE = os.getenv(
    "SESSION_FILE", os.path.join(os.path.dirname(__file__), "session.json")
)
VERSION_CACHE_HOURS = 24
FALLBACK_APP_VERSION = "26.15.0"
TIMEOUT = int(os.getenv("SOCKET_TIMEOUT", "15"))  # секунды


# --- Работа с сессией ---
def load_session():
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_session(data: dict):
    with open(SESSION_FILE, "w") as f:
        json.dump(data, f)


def get_or_create_device_id() -> str:
    sess = load_session()
    if "deviceId" not in sess:
        sess["deviceId"] = str(uuid.uuid4())
        save_session(sess)
    return sess["deviceId"]


def save_auth_token(token: str):
    sess = load_session()
    sess["authToken"] = token
    save_session(sess)


def get_saved_auth_token():
    return load_session().get("authToken")


# --- Версия приложения ---
VERSION_CHECK_URL = "https://ru-oneme-app.en.uptodown.com/android"


def get_latest_app_version() -> str:
    sess = load_session()
    cached = sess.get("appVersionCache")
    if cached and time.time() - cached.get("checkedAt", 0) < VERSION_CACHE_HOURS * 3600:
        return cached.get("version", FALLBACK_APP_VERSION)
    try:
        import urllib.request

        req = urllib.request.Request(
            VERSION_CHECK_URL, headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        match = re.search(r"(\d{2}\.\d+\.\d+)\s*\W*Communication Platform LLC", html)
        version = match.group(1) if match else FALLBACK_APP_VERSION
        save_session(
            {
                **load_session(),
                "appVersionCache": {"version": version, "checkedAt": time.time()},
            }
        )
        return version
    except Exception as e:
        logger.warning(f"[version] fetch failed, using fallback: {e}")
        return (
            cached.get("version", FALLBACK_APP_VERSION)
            if cached
            else FALLBACK_APP_VERSION
        )


# --- Декодирование с перебором кодировок ---
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


# --- LZ4 с использованием библиотеки ---
def _lz4_decompress_block(data: bytes) -> bytes:
    # Библиотека lz4.block ожижает размер распакованного блока.
    # Мы не знаем точный размер, поэтому используем lz4.block.decompress с max size.
    # Для надежности можно попробовать распаковать с максимальным размером 1 МБ,
    # но лучше использовать lz4.frame.decompress, если данные в формате frame.
    # Однако сервер присылает сырой блок, поэтому воспользуемся lz4.block.decompress
    # с указанием большого лимита.
    try:
        # Пытаемся распаковать, предполагая, что размер не превышает 2 МБ.
        return lz4.block.decompress(data, uncompressed_size=2 * 1024 * 1024)
    except Exception:
        # Если не вышло, пробуем без указания размера (может выбросить ошибку)
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

        ver, cmd, seq, opcode, packed_len = struct.unpack(">BHBHI", self.buf[:10])
        comp_flag = packed_len >> 24
        payload_len = packed_len & 0x00FFFFFF

        while len(self.buf) < 10 + payload_len:
            self._recv_exact_more()

        payload_bytes = self.buf[10 : 10 + payload_len]
        self.buf = self.buf[10 + payload_len :]

        payload = None
        if payload_bytes:
            try:
                data_to_parse = payload_bytes
                if comp_flag:
                    data_to_parse = _lz4_decompress_block(payload_bytes)
                parsed = msgpack.unpackb(data_to_parse, raw=True, strict_map_key=False)
                payload = _decode_bytes_deep(parsed)
            except Exception as e:
                logger.debug(f"Unpack failed: {e}")
                payload = {"raw": payload_bytes.hex()}

        return {
            "ver": ver,
            "cmd": cmd,
            "seq": seq,
            "opcode": opcode,
            "payload": payload,
        }

    def connect(self, existing_token: str = None):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((HOST, PORT))
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
        self.send(6, payload)

    def close(self):
        self._connected = False
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass


# --- Цикл приёма ---
def recv_loop(client: MaxClient, out_queue: queue.Queue, stop_event: threading.Event):
    while not stop_event.is_set():
        try:
            packet = client.recv_packet()
        except socket.timeout:
            continue
        except (ConnectionError, OSError) as e:
            logger.warning(f"recv_loop stopped: {e}")
            break

        cmd_status = (
            "OK"
            if packet["cmd"] == 256
            else "ERROR" if packet["cmd"] == 768 else str(packet["cmd"])
        )
        logger.info(
            f"RECEIVED: opcode={packet['opcode']}, cmd={packet['cmd']} ({cmd_status})"
        )

        if packet["opcode"] == 18 and packet["cmd"] == 256 and packet.get("payload"):
            token_attrs = packet["payload"].get("tokenAttrs")
            if token_attrs and "LOGIN" in token_attrs:
                save_auth_token(token_attrs["LOGIN"]["token"])
                logger.info("[session] auth token saved")

        out_queue.put(packet)


# --- Одноразовый запрос вне основного WS-соединения (для видео/файлов) ---
def fetch_once(opcode: int, payload: dict, wait_opcode: int, timeout: float = 15.0):
    """Открывает отдельное короткое соединение, логинится сохранённым токеном,
    шлёт один запрос и ждёт ответ с нужным opcode. Используется там, где не
    хочется тащить это через долгоживущий /relay (скачивание видео/файлов)."""
    saved_token = get_saved_auth_token()
    client = MaxClient()
    client.connect(existing_token=saved_token)
    try:
        deadline = time.time() + timeout

        # Ждём ответ на handshake (opcode=6), прежде чем слать что-либо ещё.
        handshake_ok = False
        while time.time() < deadline and not handshake_ok:
            try:
                packet = client.recv_packet()
            except socket.timeout:
                continue
            if packet["opcode"] == 6:
                handshake_ok = packet["cmd"] == 256
                if not handshake_ok:
                    logger.warning(f"[fetch_once] handshake failed: {packet.get('payload')!r}")
                    return packet
        if not handshake_ok:
            logger.warning("[fetch_once] handshake timeout")
            return None

        # Без этого шага сессия остаётся не-ONLINE и сервер отвечает
        # proto.state / "Must be ONLINE session" на любой содержательный запрос
        # (opcode=19 — тот же шаг, что и в основном /relay-соединении).
        # Токен нужен явно: в /relay-маршруте bridge сам подставляет его в
        # payload каждого исходящего пакета (см. relay()), здесь этого шага нет.
        sync_payload = {"chatsSync": 0, "contactsSync": 0, "interactive": True}
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
                    logger.warning(f"[fetch_once] online-sync failed: {packet.get('payload')!r}")
                    return packet
        if not sync_ok:
            logger.warning("[fetch_once] online-sync timeout")
            return None

        if "token" not in payload and saved_token:
            payload["token"] = saved_token
        client.send(opcode, payload)

        while time.time() < deadline:
            try:
                packet = client.recv_packet()
            except socket.timeout:
                continue
            if packet["opcode"] == wait_opcode:
                return packet
        return None
    finally:
        client.close()


# --- Flask приложение ---
app = Flask(__name__, static_folder="static")
sock = Sock(app)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


@app.route("/img")
def proxy_image():
    from flask import request, Response
    import urllib.request

    url = request.args.get("url", "")
    allowed_hosts = ("i.oneme.ru", "iv.okcdn.ru", "st.max.ru")
    if not url.startswith("https://") or not any(f"//{h}" in url for h in allowed_hosts):
        return "", 400

    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-S911B)",
                "Referer": "https://web.max.ru/",
            },
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
    from flask import request, Response, stream_with_context
    import urllib.request
    import urllib.error

    url = request.args.get("url", "")
    if not url.startswith("https://") or "okcdn.ru" not in url:
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
        upstream = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as e:
        logger.warning(f"[video proxy] HTTPError for {url}: {e}")
        return "", 502
    except Exception as e:
        logger.warning(f"[video proxy] failed for {url}: {e}")
        return "", 502

    status = upstream.status
    content_type = upstream.headers.get("Content-Type", "video/mp4")
    content_range = upstream.headers.get("Content-Range")
    content_length = upstream.headers.get("Content-Length")
    accept_ranges = upstream.headers.get("Accept-Ranges", "bytes")

    def generate():
        try:
            while True:
                chunk = upstream.read(65536)  # 64 КБ за раз, не грузим весь файл в память
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    out_headers = {"Accept-Ranges": accept_ranges, "Cache-Control": "public, max-age=3600"}
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


@app.route("/api/video-sources", methods=["POST"])
def video_sources():
    from flask import request, jsonify

    data = request.get_json(force=True)
    try:
        packet = fetch_once(
            83,  # Opcode.videoPlay
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
        logger.warning("[video-sources] no response from MAX (timeout waiting for opcode=83)")
        return jsonify({"sources": {}, "error": "timeout"})

    if packet["cmd"] != 256:
        logger.warning(f"[video-sources] MAX returned error cmd={packet['cmd']} payload={packet.get('payload')!r}")
        return jsonify({"sources": {}, "error": f"cmd={packet['cmd']}"})

    if not isinstance(packet.get("payload"), dict):
        logger.warning(f"[video-sources] unexpected payload shape: {packet.get('payload')!r}")
        return jsonify({"sources": {}})

    mp4_keys = {
        "MP4_1080": "1080p", "MP4_720": "720p", "MP4_480": "480p",
        "MP4_360": "360p", "MP4_240": "240p", "MP4_144": "144p",
    }
    payload = packet["payload"]
    logger.info(f"[video-sources] payload: {payload!r}")
    sources = {label: payload[key] for key, label in mp4_keys.items() if payload.get(key)}

    # Если MP4-вариантов нет — пробуем HLS/внешнюю ссылку (как в Komet).
    # Фронтенд играет .m3u8 через hls.js.
    if not sources:
        hls = payload.get("HLS")
        if hls:
            sources["Авто (HLS)"] = hls
        external = payload.get("EXTERNAL")
        if external:
            sources["Источник"] = external

    return jsonify({"sources": sources})


@app.route("/api/download", methods=["POST"])
def download_file():
    from flask import request, Response

    data = request.get_json(force=True)
    url = data.get("url")
    token = data.get("token")
    filename = data.get("filename") or "file"
    if not url or not token:
        return "", 400

    try:
        packet = fetch_once(
            88,  # Opcode.fileDownload
            {"url": url, "token": token},
            wait_opcode=88,
        )
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
        # На случай если content уже успешно раскодировался в текст (не бинарь)
        raw_bytes = content.encode("utf-8", errors="ignore")

    return Response(
        raw_bytes,
        mimetype="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@sock.route("/relay")
def relay(ws):
    saved_token = get_saved_auth_token()
    client = MaxClient()
    out_queue = queue.Queue()
    stop_event = threading.Event()

    try:
        client.connect(existing_token=saved_token)
    except Exception as e:
        ws.send(json.dumps({"error": "Connection failed", "details": str(e)}))
        return

    t = threading.Thread(
        target=recv_loop, args=(client, out_queue, stop_event), daemon=True
    )
    t.start()

    ws.send(json.dumps({"type": "connected", "message": "Connected to MAX server"}))
    if saved_token:
        ws.send(
            json.dumps(
                {
                    "type": "session_restored",
                    "message": "Используется сохранённая сессия — авторизация не требуется",
                }
            )
        )

    try:
        while True:
            # Отправка пакетов из очереди
            try:
                while True:
                    packet = out_queue.get_nowait()
                    ws.send(json.dumps(packet))
            except queue.Empty:
                pass

            # Приём сообщений от клиента
            msg = ws.receive(timeout=0.2)
            if msg is None:
                continue

            req = json.loads(msg)
            opcode = req.get("opcode")
            payload = req.get("payload", {})

            # ---- Всегда вставляем свежий сохранённый токен, но не затираем
            # токен, который фронт передал явно (например, OTP-токен при
            # проверке кода — это другой токен, не auth-токен сессии) ----
            if "token" not in payload:
                current_token = get_saved_auth_token()
                if current_token:
                    payload["token"] = current_token
            # ---------------------------------------------------------------

            # ---- Обработка пинга (opcode=0) ----
            if opcode == 0:
                # Отправляем ответ-пустышку, чтобы клиент знал, что мы живы
                ws.send(json.dumps({"opcode": 0, "payload": {"pong": True}}))
                continue
            # -----------------------------------

            if opcode is not None:
                client.send(opcode, payload)

    except Exception as e:
        logger.info(f"Connection closed: {e}")
    finally:
        stop_event.set()
        client.close()


if __name__ == "__main__":
    # Для продакшена используйте debug=False и запускайте через gunicorn или подобное
    debug_mode = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    port = int(os.getenv("PORT", "8080"))
    host = os.getenv("HOST", "0.0.0.0")
    logger.info(f"Starting server on {host}:{port}, debug={debug_mode}")
    app.run(host=host, port=port, debug=debug_mode)
