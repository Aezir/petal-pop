@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 花漾贴贴 demo 启动中… 关掉这个窗口游戏就停。
start "" http://127.0.0.1:8765/demo/
python -m http.server 8765 --bind 127.0.0.1
