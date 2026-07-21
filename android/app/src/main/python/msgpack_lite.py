"""
Компактная чистая реализация MessagePack (packb/unpackb) без C-расширений.

Зачем: пакет `msgpack` с PyPI по умолчанию собирает C-расширение,
а Chaquopy (Python внутри Android APK) не входит в список пакетов,
для которых у него есть готовые Android-сборки. Здесь — только то,
что реально используется в bridge.py: одноразовые packb()/unpackb().

Совместимо по сигнатурам с настоящим msgpack в объёме, который
использует bridge.py:
    msgpack.packb(payload, use_bin_type=True)
    msgpack.unpackb(data, raw=True, strict_map_key=False)

raw=True означает, что строки НЕ декодируются из utf-8 автоматически —
возвращаются как bytes (это то поведение, которое bridge.py и ожидает,
он сам потом декодирует через _decode_bytes_deep).
"""

import struct

__all__ = ["packb", "unpackb"]


# ---------------------------------------------------------------- packing

def packb(obj, use_bin_type=True):
    out = bytearray()
    _pack(obj, out, use_bin_type)
    return bytes(out)


def _pack(obj, out, use_bin_type):
    if obj is None:
        out.append(0xC0)
    elif obj is False:
        out.append(0xC2)
    elif obj is True:
        out.append(0xC3)
    elif isinstance(obj, int):
        _pack_int(obj, out)
    elif isinstance(obj, float):
        out.append(0xCB)
        out.extend(struct.pack(">d", obj))
    elif isinstance(obj, (bytes, bytearray)):
        data = bytes(obj)
        if use_bin_type:
            _pack_bin(data, out)
        else:
            _pack_str_bytes(data, out)
    elif isinstance(obj, str):
        _pack_str_bytes(obj.encode("utf-8"), out)
    elif isinstance(obj, (list, tuple)):
        _pack_array(obj, out, use_bin_type)
    elif isinstance(obj, dict):
        _pack_map(obj, out, use_bin_type)
    else:
        raise TypeError(f"msgpack_lite: cannot pack type {type(obj)!r}")


def _pack_int(n, out):
    if 0 <= n <= 0x7F:
        out.append(n)
    elif -32 <= n < 0:
        out.append(n & 0xFF)
    elif 0 <= n <= 0xFF:
        out.append(0xCC); out.append(n)
    elif 0 <= n <= 0xFFFF:
        out.append(0xCD); out.extend(struct.pack(">H", n))
    elif 0 <= n <= 0xFFFFFFFF:
        out.append(0xCE); out.extend(struct.pack(">I", n))
    elif 0 <= n <= 0xFFFFFFFFFFFFFFFF:
        out.append(0xCF); out.extend(struct.pack(">Q", n))
    elif -0x80 <= n < 0:
        out.append(0xD0); out.extend(struct.pack(">b", n))
    elif -0x8000 <= n < 0:
        out.append(0xD1); out.extend(struct.pack(">h", n))
    elif -0x80000000 <= n < 0:
        out.append(0xD2); out.extend(struct.pack(">i", n))
    elif -0x8000000000000000 <= n < 0:
        out.append(0xD3); out.extend(struct.pack(">q", n))
    else:
        raise OverflowError("msgpack_lite: integer too large")


def _pack_bin(data, out):
    n = len(data)
    if n <= 0xFF:
        out.append(0xC4); out.append(n)
    elif n <= 0xFFFF:
        out.append(0xC5); out.extend(struct.pack(">H", n))
    else:
        out.append(0xC6); out.extend(struct.pack(">I", n))
    out.extend(data)


def _pack_str_bytes(data, out):
    n = len(data)
    if n <= 0x1F:
        out.append(0xA0 | n)
    elif n <= 0xFF:
        out.append(0xD9); out.append(n)
    elif n <= 0xFFFF:
        out.append(0xDA); out.extend(struct.pack(">H", n))
    else:
        out.append(0xDB); out.extend(struct.pack(">I", n))
    out.extend(data)


def _pack_array(seq, out, use_bin_type):
    n = len(seq)
    if n <= 0x0F:
        out.append(0x90 | n)
    elif n <= 0xFFFF:
        out.append(0xDC); out.extend(struct.pack(">H", n))
    else:
        out.append(0xDD); out.extend(struct.pack(">I", n))
    for item in seq:
        _pack(item, out, use_bin_type)


def _pack_map(d, out, use_bin_type):
    n = len(d)
    if n <= 0x0F:
        out.append(0x80 | n)
    elif n <= 0xFFFF:
        out.append(0xDE); out.extend(struct.pack(">H", n))
    else:
        out.append(0xDF); out.extend(struct.pack(">I", n))
    for k, v in d.items():
        _pack(k, out, use_bin_type)
        _pack(v, out, use_bin_type)


# -------------------------------------------------------------- unpacking

def unpackb(data, raw=True, strict_map_key=False):
    pos, value = _unpack(data, 0, raw)
    return value


def _unpack(data, pos, raw):
    b = data[pos]
    pos += 1

    if b <= 0x7F:
        return pos, b
    if b >= 0xE0:
        return pos, b - 256
    if 0x80 <= b <= 0x8F:
        return _unpack_map(data, pos, b & 0x0F, raw)
    if 0x90 <= b <= 0x9F:
        return _unpack_array(data, pos, b & 0x0F, raw)
    if 0xA0 <= b <= 0xBF:
        n = b & 0x1F
        s = bytes(data[pos:pos + n]); pos += n
        return pos, (s if raw else s.decode("utf-8"))

    if b == 0xC0:
        return pos, None
    if b == 0xC2:
        return pos, False
    if b == 0xC3:
        return pos, True

    if b == 0xC4:
        n = data[pos]; pos += 1
        v = bytes(data[pos:pos + n]); pos += n
        return pos, v
    if b == 0xC5:
        n = struct.unpack_from(">H", data, pos)[0]; pos += 2
        v = bytes(data[pos:pos + n]); pos += n
        return pos, v
    if b == 0xC6:
        n = struct.unpack_from(">I", data, pos)[0]; pos += 4
        v = bytes(data[pos:pos + n]); pos += n
        return pos, v

    if b == 0xCA:
        v = struct.unpack_from(">f", data, pos)[0]; pos += 4
        return pos, v
    if b == 0xCB:
        v = struct.unpack_from(">d", data, pos)[0]; pos += 8
        return pos, v

    if b == 0xCC:
        return pos + 1, data[pos]
    if b == 0xCD:
        v = struct.unpack_from(">H", data, pos)[0]; return pos + 2, v
    if b == 0xCE:
        v = struct.unpack_from(">I", data, pos)[0]; return pos + 4, v
    if b == 0xCF:
        v = struct.unpack_from(">Q", data, pos)[0]; return pos + 8, v

    if b == 0xD0:
        v = struct.unpack_from(">b", data, pos)[0]; return pos + 1, v
    if b == 0xD1:
        v = struct.unpack_from(">h", data, pos)[0]; return pos + 2, v
    if b == 0xD2:
        v = struct.unpack_from(">i", data, pos)[0]; return pos + 4, v
    if b == 0xD3:
        v = struct.unpack_from(">q", data, pos)[0]; return pos + 8, v

    if b == 0xD9:
        n = data[pos]; pos += 1
        s = bytes(data[pos:pos + n]); pos += n
        return pos, (s if raw else s.decode("utf-8"))
    if b == 0xDA:
        n = struct.unpack_from(">H", data, pos)[0]; pos += 2
        s = bytes(data[pos:pos + n]); pos += n
        return pos, (s if raw else s.decode("utf-8"))
    if b == 0xDB:
        n = struct.unpack_from(">I", data, pos)[0]; pos += 4
        s = bytes(data[pos:pos + n]); pos += n
        return pos, (s if raw else s.decode("utf-8"))

    if b == 0xDC:
        n = struct.unpack_from(">H", data, pos)[0]; pos += 2
        return _unpack_array(data, pos, n, raw)
    if b == 0xDD:
        n = struct.unpack_from(">I", data, pos)[0]; pos += 4
        return _unpack_array(data, pos, n, raw)
    if b == 0xDE:
        n = struct.unpack_from(">H", data, pos)[0]; pos += 2
        return _unpack_map(data, pos, n, raw)
    if b == 0xDF:
        n = struct.unpack_from(">I", data, pos)[0]; pos += 4
        return _unpack_map(data, pos, n, raw)

    raise ValueError(f"msgpack_lite: unknown type byte 0x{b:02x}")


def _unpack_array(data, pos, n, raw):
    result = []
    for _ in range(n):
        pos, v = _unpack(data, pos, raw)
        result.append(v)
    return pos, result


def _unpack_map(data, pos, n, raw):
    result = {}
    for _ in range(n):
        pos, k = _unpack(data, pos, raw)
        pos, v = _unpack(data, pos, raw)
        result[k] = v
    return pos, result
