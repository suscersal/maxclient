import asyncio
import json
import logging
import os
import random
import re
import socket
import ssl
import struct
import time
import uuid

import msgpack
from aiohttp import web, WSMsgType

# Настройка логирования
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


FALLBACK_APP_VERSION = "26.22.3"
VERSION_CHECK_URL = "https://ru-oneme-app.en.uptodown.com/android"
VERSION_CACHE_HOURS = 24


def get_latest_app_version() -> str:
    """Подтягивает актуальную версию MAX с публичной страницы Uptodown,
    чтобы не хардкодить её и не ловить client.unsupported-version после
    очередного обновления приложения. Кэширует результат на сутки."""
    sess = load_session()
    cached = sess.get("appVersionCache")
    if cached:
        checked_at = cached.get("checkedAt", 0)
        if time.time() - checked_at < VERSION_CACHE_HOURS * 3600:
            return cached.get("version", FALLBACK_APP_VERSION)

    try:
        import urllib.request
        req = urllib.request.Request(
            VERSION_CHECK_URL,
            headers={"User-Agent": "Mozilla/5.0"}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        match = re.search(
            r"(\d{2}\.\d+\.\d+)\s*\W*Communication Platform LLC", html)
        version = match.group(1) if match else FALLBACK_APP_VERSION

        sess["appVersionCache"] = {
            "version": version, "checkedAt": time.time()}
        save_session(sess)
        logger.info(f"[version] latest MAX version detected: {version}")
        return version

    except Exception as e:
        logger.warning(
            f"[version] failed to fetch latest version, using fallback: {e}")
        return cached.get("version", FALLBACK_APP_VERSION) if cached else FALLBACK_APP_VERSION


def _decode_bytes_deep(obj):
    """msgpack с raw=True отдаёт строки как bytes — рекурсивно декодируем
    их в str, не падая на отдельных не-UTF8 полях (например, бинарных ID)."""
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


class MaxClient:
    def __init__(self, on_message):
        self.sock = None
        self.seq = 0
        self.on_message = on_message
        self.buf = b""
        self._recv_task = None
        self._connected = False
        self._handshake_done = False

    def pack(self, opcode: int, payload: dict) -> bytes:
        """Упаковка пакета по спецификации протокола"""
        self.seq = (self.seq + 1) % 256
        body = msgpack.packb(payload, use_bin_type=True)
        header = struct.pack(">BHBHI", 10, 0, self.seq, opcode, len(body))
        return header + body

    def send(self, opcode: int, payload: dict):
        """Отправка пакета"""
        pkt = self.pack(opcode, payload)
        self.sock.sendall(pkt)
        logger.debug(
            f"Sent: opcode={opcode}, seq={self.seq}, payload_keys={list(payload.keys())}, has_token={'token' in payload and bool(payload.get('token'))}")
        return self.seq

    def recv_packet(self) -> dict:
        """Прием и распаковка пакета"""
        while len(self.buf) < 10:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed")
            self.buf += chunk

        ver, cmd, seq, opcode, packed_len = struct.unpack(
            ">BHBHI", self.buf[:10])
        comp_flag = packed_len >> 24
        payload_len = packed_len & 0x00FFFFFF

        logger.debug(
            f"Header: ver={ver}, cmd={cmd}, seq={seq}, opcode={opcode}, comp_flag={comp_flag}, payload_len={payload_len}")

        while len(self.buf) < 10 + payload_len:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("Connection closed")
            self.buf += chunk

        payload_bytes = self.buf[10:10 + payload_len]
        self.buf = self.buf[10 + payload_len:]

        payload = None

        if payload_bytes:
            parsed = None
            for offset in range(0, 5):
                try:
                    unpacker = msgpack.Unpacker(raw=True, strict_map_key=False)
                    unpacker.feed(payload_bytes[offset:])
                    candidate = next(iter(unpacker))
                    if isinstance(candidate, dict):
                        parsed = candidate
                        logger.debug(
                            f"Msgpack unpack success (offset {offset})")
                        break
                except Exception:
                    continue

            if parsed is not None:
                payload = _decode_bytes_deep(parsed)
            else:
                logger.debug(
                    "Msgpack unpack failed at all offsets (no dict found)")
                payload = {"raw": payload_bytes.hex()}

        return {
            "ver": ver,
            "cmd": cmd,
            "seq": seq,
            "opcode": opcode,
            "payload": payload
        }

    async def connect(self, existing_token: str = None):
        """Подключение к серверу"""
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE

            logger.info(f"Connecting to {HOST}:{PORT}")
            raw = socket.create_connection((HOST, PORT))
            self.sock = ctx.wrap_socket(raw, server_hostname=HOST)
            self._connected = True

            self._recv_task = asyncio.create_task(self._recv_loop())

            await self._send_handshake(existing_token)

        except Exception as e:
            logger.error(f"Connection failed: {e}")
            raise

    async def _send_handshake(self, existing_token: str = None):
        """Handshake (opcode 6)"""
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
                "appVersion": "26.6.1",
                "screen": "xxhdpi 480dpi 1080x2340",
                "timezone": "Europe/Moscow",
                "pushDeviceType": "GCM",
                "arch": "arm64-v8a",
                "buildNumber": 6498,
            },
        }
        if existing_token:
            # Переиспользуем токен уже пройденной авторизации, чтобы не
            # гонять START_AUTH/CHECK_CODE заново при каждом подключении.
            payload["token"] = existing_token
        logger.debug("Sending handshake")
        self.send(6, payload)
        logger.info("Handshake sent")

    async def _recv_loop(self):
        """Цикл приема сообщений"""
        try:
            while self._connected:
                try:
                    packet = await asyncio.get_event_loop().run_in_executor(
                        None, self.recv_packet
                    )

                    cmd_status = "OK" if packet['cmd'] == 256 else "ERROR" if packet[
                        'cmd'] == 768 else f"UNKNOWN({packet['cmd']})"

                    if packet['opcode'] == 6 and packet['cmd'] == 256:
                        self._handshake_done = True
                        logger.info("✅ Handshake successful!")

                    logger.info(
                        f"RECEIVED: opcode={packet['opcode']}, cmd={packet['cmd']} ({cmd_status})")

                    # Сохраняем auth-токен после успешного CHECK_CODE (opcode 18)
                    if packet['opcode'] == 18 and packet['cmd'] == 256 and packet.get('payload'):
                        token_attrs = packet['payload'].get('tokenAttrs')
                        if token_attrs and 'LOGIN' in token_attrs:
                            save_auth_token(token_attrs['LOGIN']['token'])
                            logger.info("[session] auth token saved")

                    if packet['payload']:
                        logger.debug(f"Payload: {packet['payload']}")

                    await self.on_message(packet)

                except ConnectionError as e:
                    logger.warning(f"Connection error: {e}")
                    break
                except Exception as e:
                    logger.error(f"Receive error: {e}")
                    break
        except asyncio.CancelledError:
            logger.info("Receive loop cancelled")
        finally:
            self._connected = False
            await self.close()

    async def close(self):
        """Закрытие соединения"""
        self._connected = False
        if self._recv_task:
            self._recv_task.cancel()
        if self.sock:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None


# ---------- HTTP/WS мост ----------

async def relay(request):
    ws_client = web.WebSocketResponse()
    await ws_client.prepare(request)
    logger.info("WebSocket connection established")

    async def on_message(packet):
        try:
            await ws_client.send_str(json.dumps(packet))
        except Exception as e:
            logger.error(f"Failed to send to WebSocket: {e}")

    client = None
    try:
        client = MaxClient(on_message)
        saved_token = get_saved_auth_token()
        await client.connect(existing_token=saved_token)

        await ws_client.send_str(json.dumps({
            "type": "connected",
            "message": "Connected to MAX server"
        }))

        if saved_token:
            await ws_client.send_str(json.dumps({
                "type": "session_restored",
                "message": "Используется сохранённая сессия — авторизация не требуется",
            }))

        async for msg in ws_client:
            if msg.type == WSMsgType.TEXT:
                try:
                    req = json.loads(msg.data)
                    opcode = req.get("opcode")
                    payload = req.get("payload", {})

                    # Если фронт не прислал token явно, а сохранённая сессия есть —
                    # подставляем его сами (фронт не знает реальное значение токена).
                    if "token" not in payload and saved_token:
                        payload["token"] = saved_token

                    if opcode is not None:
                        client.send(opcode, payload)
                    else:
                        logger.warning(f"Invalid request format: {req}")

                except json.JSONDecodeError as e:
                    logger.error(f"Invalid JSON: {e}")
                except Exception as e:
                    logger.error(f"Error processing request: {e}")
                    await ws_client.send_str(json.dumps({
                        "error": str(e)
                    }))

            elif msg.type == WSMsgType.ERROR:
                logger.error("WebSocket error")
                break
            elif msg.type == WSMsgType.CLOSE:
                logger.info("WebSocket closed by client")

    except Exception as e:
        logger.error(f"Relay error: {e}")
        try:
            await ws_client.send_str(json.dumps({
                "error": "Connection failed",
                "details": str(e)
            }))
        except Exception:
            pass
    finally:
        if client:
            await client.close()
        await ws_client.close()
        logger.info("Connection closed")

    return ws_client


# ---------- Основное приложение ----------

app = web.Application()
app.router.add_get("/relay", relay)


async def index(request):
    return web.FileResponse(os.path.join(os.path.dirname(__file__), "static", "index.html"))


app.router.add_get("/", index)
app.router.add_static("/", path="static", show_index=False)

if __name__ == "__main__":
    logger.info("Starting server on http://0.0.0.0:8080")
    web.run_app(app, host="0.0.0.0", port=8080)
