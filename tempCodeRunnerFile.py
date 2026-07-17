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

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

HOST = "api.oneme.ru"
PORT = 443

SESSION_FILE = os.path.join(os.path.dirname(__file__), "session.json")


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


FALLBACK_APP_VERSION = "26.15.0"
VERSION_CHECK_URL = "https://ru-oneme-app.en.uptodown.com/android"
VERSION_CACHE_HOURS = 24


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


def _decode_bytes_deep(obj):
    if isinstance(obj, bytes):
        try:
            return obj.decode("utf-8")
        except UnicodeDecodeError:
            return obj.hex()
    if isinstance(obj, dict):
        return {_decode_bytes_deep(k): _decode_bytes_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decode_bytes_deep(v) for v in obj]
    return obj


def _lz4_decompress_block(data: bytes) -> bytes:
    """Распаковка сырого LZ4-блока (без заголовка/префикса размера) —
    именно так сервер MAX присылает сжатые пакеты."""
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        token = data[i]
        i += 1
        lit_len = token >> 4
        if lit_len == 15:
            while True:
                b = data[i]
                i += 1
                lit_len += b
                if b != 255:
                    break
        out += data[i : i + lit_len]
        i += lit_len
        if i >= n:
            break
        offset = data[i] | (data[i + 1] << 8)
        i += 2
        match_len = (token & 0x0F) + 4
        if (token & 0x0F) == 15:
            while True:
                b = data[i]
                i += 1
                match_len += b
                if b != 255:
                    break
        start = len(out) - offset
        for k in range(match_len):
            out.append(out[start + k])
    return bytes(out)


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
        logger.debug(
            f"Sent: opcode={opcode}, seq={self.seq}, has_token={'token' in payload and bool(payload.get('token'))}"
        )

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
        self.sock.settimeout(2.0)
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


# ---------- Flask app ----------

app = Flask(__name__, static_folder="static")
sock = Sock(app)


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory("static", filename)


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
            try:
                while True:
                    packet = out_queue.get_nowait()
                    ws.send(json.dumps(packet))
            except queue.Empty:
                pass

            msg = ws.receive(timeout=0.2)
            if msg is None:
                continue

            req = json.loads(msg)
            opcode = req.get("opcode")
            payload = req.get("payload", {})
            if "token" not in payload:
                current_token = (
                    get_saved_auth_token()
                )  # читаем свежий токен, а не тот, что был на момент коннекта
                if current_token:
                    payload["token"] = current_token
            if opcode is not None:
                client.send(opcode, payload)

    except Exception as e:
        logger.info(f"Connection closed: {e}")
    finally:
        stop_event.set()
        client.close()


if __name__ == "__main__":
    logger.info("Starting server on http://0.0.0.0:8080")
    app.run(host="0.0.0.0", port=8080, debug=False)
