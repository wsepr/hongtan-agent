@echo off
rem hongtan Agent launcher (Windows)
rem Requires Node.js 22 or newer.
setlocal

set "SCRIPT_DIR=%~dp0"
set "NODEEXE="

if defined HONGTAN_AGENT_NODE call :probe "%HONGTAN_AGENT_NODE%"
if not defined NODEEXE for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODEEXE call :probe "%%~i"
)
if not defined NODEEXE if defined USERPROFILE (
    for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
        if not defined NODEEXE if exist "%%~d\node.exe" call :probe "%%~d\node.exe"
    )
)
if "%NODEEXE%"=="" goto :noNode

"%NODEEXE%" "%SCRIPT_DIR%..\runtime\hongtan-agent.mjs" %*
exit /b %errorlevel%

:probe
set "NODEMAJOR="
for /f "usebackq delims=" %%j in (`call "%~1" -p "process.versions.node.split('.')[0]" 2^>nul`) do set "NODEMAJOR=%%j"
if "%NODEMAJOR%"=="" goto :eof
if %NODEMAJOR% LSS 22 goto :eof
set "NODEEXE=%~1"
goto :eof

:noNode
echo [hongtan] Node.js 22 or newer is required. Install Node.js or set HONGTAN_AGENT_NODE.
exit /b 1
