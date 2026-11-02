@echo off
rem Автоответчик Claude Room: следит за комнатой и сразу отвечает. Остановить: Ctrl+C или закрыть окно.
chcp 65001 >nul
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" watch.mjs
pause
