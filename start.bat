@echo off
@chcp 65001 >nul
title Discord Digests 控制台
cd /d "%~dp0"

echo ========================================================
echo               Discord Digests 啟動程式
echo ========================================================
echo.

if not exist "discordwatch.exe" (
    echo [錯誤] 找不到 discordwatch.exe！
    echo 請先在 backend 目錄編譯：go build -o ../discordwatch.exe .
    pause
    exit /b 1
)

if not exist ".env" (
    echo [警告] 找不到 .env 設定檔！
    if exist ".env.example" (
        echo 正在自 .env.example 複製產生 .env...
        copy .env.example .env >nul
    )
)

echo 正在檢查並關閉舊有衝突進程...
taskkill /F /IM discordwatch.exe >nul 2>&1

echo 正在啟動訊息收集器 (watch)...
start "Discord Digests - Watcher" /min cmd /c "title Discord Digests [Watch] && chcp 65001 >nul && discordwatch.exe watch"

echo 正在啟動工作台伺服器 (serve)...
start "Discord Digests - Server" /min cmd /c "title Discord Digests [Serve] && chcp 65001 >nul && discordwatch.exe serve"

echo 等待服務就緒...
ping 127.0.0.1 -n 3 >nul

echo 正在開啟瀏覽器前往 http://127.0.0.1:8787 ...
start http://127.0.0.1:8787

echo.
echo ========================================================
echo  [OK] Discord Digests 服務已在背景啟動！
echo  - 工作台網址: http://127.0.0.1:8787
echo  - 訊息收集器: 運作中 (背景監聽 Discord 訊息)
echo ========================================================
echo.
echo 控制選項：
echo   [S] 查看各頻道接收狀態 (status)
echo   [O] 重新打開瀏覽器工作台
echo   [Q] 關閉所有服務並退出
echo.

:menu_loop
set /p opt="請輸入選項 (S/O/Q) 並按 Enter: "
if /i "%opt%"=="s" goto do_status
if /i "%opt%"=="o" goto do_open
if /i "%opt%"=="q" goto do_quit
echo 無效的選項，請輸入 S、O 或 Q。
goto menu_loop

:do_status
echo.
discordwatch.exe status
echo.
goto menu_loop

:do_open
start http://127.0.0.1:8787
goto menu_loop

:do_quit
echo.
echo 正在停止所有 Discord Digests 服務...
taskkill /F /IM discordwatch.exe >nul 2>&1
echo [OK] 已安全關閉所有服務。
ping 127.0.0.1 -n 2 >nul
exit /b 0
