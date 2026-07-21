"""
Вызывается из MainActivity.kt. Настраивает переменные окружения
(они должны быть выставлены ДО import bridge, потому что bridge.py
читает их через os.getenv на уровне модуля), затем запускает Flask
прямо в этом процессе на 127.0.0.1.

start_server() блокирует поток — Kotlin запускает её в отдельном Thread.
"""

import os


def start_server(session_file: str, port: int):
    os.environ["SESSION_FILE"] = session_file
    os.environ["HOST"] = "127.0.0.1"
    os.environ["PORT"] = str(port)
    os.environ.setdefault("FLASK_DEBUG", "False")
    os.environ.setdefault("SOCKET_TIMEOUT", "15")

    import bridge  # импорт ПОСЛЕ выставления переменных окружения

    # bridge.py не выполнит свой `if __name__ == "__main__":` блок,
    # т.к. импортируется как модуль, а не запускается напрямую —
    # поэтому стартуем сервер здесь сами.
    bridge.app.run(
        host="127.0.0.1",
        port=int(port),
        debug=False,
        use_reloader=False,
        threaded=True,
    )
