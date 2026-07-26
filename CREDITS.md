### Благодарности (Credits)

Проект MAX Client (Flask-версия) разработан с использованием следующих технологий и выражает благодарность их создателям: 

* **KometTeam** — за структуру сетевых запросов, на основе которой построен bridge.py.
* **[Chaquopy](https://chaquo.com/chaquopy/)** — embedded CPython внутри Android APK, на нём держится Android-сборка.
* **[pywebview](https://pywebview.flowrl.com/)** — окно с UI для десктопных (Linux/Windows) сборок.
* **[PyInstaller](https://pyinstaller.org/)** — упаковка десктопных сборок в один исполняемый файл.
* **[Flask](https://flask.palletsprojects.com/) и [flask-sock](https://github.com/miguelgrinberg/flask-sock)** — HTTP/WebSocket-сервер моста.
* **[msgpack](https://msgpack.org/)** — сериализация сообщений (в Android-сборке — через собственную чистую реализацию msgpack_lite.py, т.к. Chaquopy не собирает C-расширение).
* **[lz4](https://github.com/python-lz4/python-lz4)** — распаковка сжатых пакетов.
* **[softprops/action-gh-release](https://github.com/softprops/action-gh-release)** — публикация GitHub Releases из CI.
* **[shields.io](https://shields.io/)** — бейдж со ссылкой на скачивание APK.