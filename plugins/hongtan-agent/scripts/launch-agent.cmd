@echo off
rem hongtan Agent launcher (Windows)
rem Node >= 22 present -> runtime-launch.mjs (managed runtime first, else system Node)
rem no usable Node     -> bootstrap-runtime.ps1 (download per runtime.manifest.json + SHA-256)
setlocal

rem PATH may contain several node.exe: probing only the first `where node` hit misroutes to
rem the no-Node bootstrap when the first one is < 22 but a newer one exists later. Iterate all
rem candidates and pick the first with major >= 22. The major version must be a pure number
rem before IF comparison: `node -v` prints v22.14.0 and cmd IF degrades to string comparison
rem when an operand contains dots (measured: "9.11.1" LSS "22" is false), so Node <= 9 would
rem be misread as "has Node >= 22". No parsable major version -> treat as no Node.
set "NODEEXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODEEXE call :probe "%%~i"
)
if "%NODEEXE%"=="" goto :noNode

set "SCRIPT_DIR=%~dp0"
"%NODEEXE%" "%SCRIPT_DIR%runtime-launch.mjs" %*
exit /b %errorlevel%

:probe
rem usebackq + call prefix: cmd /c strips the outer quotes and breaks paths with spaces; call
rem re-parses without applying that strip rule (verified with a spaced path). Also the '.'
rem single quotes inside -p would cut the plain '...' command delimiter of for /f short, so the
rem command must be delimited with backticks (usebackq).
set "NODEMAJOR="
for /f "usebackq delims=" %%j in (`call "%~1" -p "process.versions.node.split('.')[0]" 2^>nul`) do set "NODEMAJOR=%%j"
if "%NODEMAJOR%"=="" goto :eof
if %NODEMAJOR% LSS 22 goto :eof
set "NODEEXE=%~1"
goto :eof

:noNode
rem No-Node path: PowerShell 5.1 is enough, pwsh 7 not required
set "SCRIPT_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%bootstrap-runtime.ps1" -ChildArgs "%*"
exit /b %errorlevel%
