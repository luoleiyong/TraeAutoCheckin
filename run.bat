@echo off
setlocal
set "ROOT=%~dp0"
set "SCRIPT=%ROOT%src\checkin.mjs"

where node >nul 2>nul
if %ERRORLEVEL%==0 (
    node "%SCRIPT%" %*
    exit /b %ERRORLEVEL%
)

set "TRAE_EXE="
for %%P in ("%LOCALAPPDATA%\Programs\Trae CN\Trae CN.exe" "D:\Trae CN\Trae CN.exe" "%ProgramFiles%\Trae CN\Trae CN.exe") do (
    if exist %%P if not defined TRAE_EXE set "TRAE_EXE=%%~P"
)
if not defined TRAE_EXE (
    echo [x] node.exe / Trae CN.exe not found. Install Node.js or edit run.bat.
    exit /b 9009
)

set ELECTRON_RUN_AS_NODE=1
"%TRAE_EXE%" "%SCRIPT%" %*
exit /b %ERRORLEVEL%