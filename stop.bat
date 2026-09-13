@echo off
@chcp 65001 >nul
title 停止 Discord Digests
echo ========================================================
echo          正在停止 Discord Digests 所有服務...
echo ========================================================
echo.
taskkill /F /IM discordwatch.exe >nul 2>&1
if errorlevel 1 goto not_running
echo [OK] 已成功終止所有 discordwatch 服務進程。
goto done
:not_running
echo [INFO] 目前沒有正在運行的 discordwatch 服務。
:done
echo.
ping 127.0.0.1 -n 2 >nul
