@echo off
cd /d "%~dp0"
echo Open http://localhost:8080
python -m http.server 8080
