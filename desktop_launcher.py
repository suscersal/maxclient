"""
Точка входа для Windows/Linux: Flask-сервер в фоне + нативное окно с UI
(аналог Android WebView + bridge_launcher.py).
"""

import os
import socket
import sys
import threading
import time


def _get_data_dir() -> str:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get(
            "XDG_DATA_HOME",
            os.path.join(os.path.expanduser("~"), ".local", "share"),
        )
    path = os.path.join(base, "maxclient")
    os.makedirs(path, exist_ok=True)
    return path


def _wait_for_port(host: str, port: int, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _start_server(session_file: str, port: int) -> None:
    os.environ["SESSION_FILE"] = session_file
    os.environ["HOST"] = "127.0.0.1"
    os.environ["PORT"] = str(port)
    os.environ.setdefault("FLASK_DEBUG", "False")
    os.environ.setdefault("SOCKET_TIMEOUT", "15")

    import bridge

    bridge.app.run(
        host="127.0.0.1",
        port=port,
        debug=False,
        use_reloader=False,
        threaded=True,
    )


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    session_file = os.path.join(_get_data_dir(), "session.json")

    server_thread = threading.Thread(
        target=_start_server,
        args=(session_file, port),
        daemon=True,
    )
    server_thread.start()

    if not _wait_for_port("127.0.0.1", port):
        print("Не удалось запустить сервер MAX Client", file=sys.stderr)
        sys.exit(1)

    import webview

    webview.create_window(
        "MAX Client",
        f"http://127.0.0.1:{port}/",
        width=420,
        height=860,
        min_size=(360, 640),
    )
    webview.start()


if __name__ == "__main__":
    main()
