@echo off
rem Запуск хаба Claude Room. Чат: http://localhost:8787
cd /d "%~dp0"
start "" http://localhost:8787
"C:\Program Files\nodejs\node.exe" server.js
pause
