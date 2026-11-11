@echo off
setlocal
if /i "%~1"=="--silent" goto run
chcp 65001 >nul
:run
call "%~dp0run.bat" run --grants
exit /b %ERRORLEVEL%