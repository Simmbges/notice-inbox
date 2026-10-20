@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "ZHIHUI_NODE="
if exist ".sites-local\portable-runtime\node-v24.19.0-win-x64\node.exe" set "ZHIHUI_NODE=%CD%\.sites-local\portable-runtime\node-v24.19.0-win-x64\node.exe"
if not defined ZHIHUI_NODE for %%N in (node.exe) do set "ZHIHUI_NODE=%%~$PATH:N"
if not defined ZHIHUI_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "ZHIHUI_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined ZHIHUI_NODE (
  echo 未找到 Node.js。请安装 Node.js 24 或以上版本，再重新双击启动调试。
  pause
  exit /b 1
)
"%ZHIHUI_NODE%" -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('调试需要 Node.js 24 或以上版本，当前为 ' + process.version); process.exit(1); }"
if errorlevel 1 (
  pause
  exit /b 1
)
echo 知会启动中，请保留此窗口；关闭窗口即可停止。
"%ZHIHUI_NODE%" --disable-warning=ExperimentalWarning "standalone\server.mjs" --open-browser %*
if errorlevel 1 pause
