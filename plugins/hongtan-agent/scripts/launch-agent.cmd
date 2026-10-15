@echo off
rem 红探 Agent launcher（Windows）
rem 有 Node >= 22 → runtime-launch.mjs（先试受管运行时，否则回退本机 Node 跑同一份源码）
rem 无 Node     → bootstrap-runtime.ps1（按 runtime.manifest.json 下载 + SHA-256 校验后执行）
setlocal

where node >nul 2>nul
if errorlevel 1 goto :noNode

rem 主版本号必须是纯数字再参与 IF 比较：`node -v` 输出形如 v22.14.0，cmd 的 IF 在操作数
rem 含点号时退化为字符串比较（实测 "9.11.1" LSS "22" 为假），Node ≤ 9 会被误判成「有 Node ≥ 22」，
rem 于是免 Node 引导路径永不触发。故用 node 自身切出纯数字主版本，取不到即按无 Node 处理。
for /f "delims=" %%i in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set NODEMAJOR=%%i
if "%NODEMAJOR%"=="" goto :noNode
if %NODEMAJOR% LSS 22 goto :noNode

set "SCRIPT_DIR=%~dp0"
node "%SCRIPT_DIR%runtime-launch.mjs" %*
exit /b %errorlevel%

:noNode
rem 免 Node 路径：PowerShell 5.1 可用即可，不需要 pwsh 7
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%bootstrap-runtime.ps1" -ChildArgs "%*"
exit /b %errorlevel%
