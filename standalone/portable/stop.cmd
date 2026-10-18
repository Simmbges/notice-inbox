@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo 未找到运行环境，请先完整解压启动包。
  pause
  exit /b 1
)
"runtime\node.exe" --disable-warning=ExperimentalWarning launcher.mjs --stop
pause
