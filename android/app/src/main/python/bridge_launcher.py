"""
Вызывается из MainActivity.kt. Настраивает переменные окружения
(они должны быть выставлены ДО import bridge, потому что bridge.py
читает их через os.getenv на уровне модуля), затем запускает Flask
прямо в этом процессе на 127.0.0.1.

start_server() блокирует поток — Kotlin запускает её в отдельном Thread.
"""

import os
import sys


def start_server(session_file: str, port: int, hotpatch_dir: str = ""):
    # Если Kotlin-сторона скачала обновлённые bridge.py/index.html и т.п.
    # (см. MainActivity.checkForOtaUpdate), они лежат в hotpatch_dir.
    # Подсовываем эту папку В НАЧАЛО sys.path, чтобы `import bridge` нашёл
    # именно скачанную версию, а не ту, что зашита в APK при сборке.
    # bridge.py сам вычисляет STATIC_DIR относительно своего __file__,
    # поэтому вместе с bridge.py подхватятся и index.html/avatars.json
    # из той же папки — пересборка APK для этого не нужна.
    if hotpatch_dir and os.path.isdir(hotpatch_dir):
        sys.path.insert(0, hotpatch_dir)

    os.environ["SESSION_FILE"] = session_file
    os.environ["HOST"] = "127.0.0.1"
    os.environ["PORT"] = str(port)
    os.environ.setdefault("FLASK_DEBUG", "False")
    os.environ.setdefault("SOCKET_TIMEOUT", "15")

    import bridge  # импорт ПОСЛЕ выставления переменных окружения и sys.path

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
