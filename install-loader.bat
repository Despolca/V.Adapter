@echo off
setlocal
REM ============================================================
REM  V.Adapter - Triển khai loader của server bằng một click
REM
REM  Tự động hoàn thành 3 việc, không cần chỉnh sửa thủ công bất kỳ file nào:
REM    1. Tìm thư mục gốc của SillyTavern
REM    2. Cài đặt loader vào <SillyTavern>\plugins\V.Adapter\
REM    3. Đổi enableServerPlugins trong config.yaml thành true (Tự động backup)
REM
REM  Sau khi chạy xong chỉ cần khởi động lại SillyTavern một lần.
REM ============================================================

set "DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  if exist "%DIR%..\..\..\..\node\node.exe" (
    set "NODE=%DIR%..\..\..\..\node\node.exe"
  ) else (
    echo [Lỗi] Không tìm thấy node. Vui lòng cài đặt Node.js trước, hoặc thêm node đi kèm của SillyTavern vào PATH.
    pause
    exit /b 1
  )
) else (
  set "NODE=node"
)

"%NODE%" "%DIR%install-loader.mjs" %*
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo [Hoàn tất] Vui lòng khởi động lại SillyTavern một lần, sau đó không cần làm thêm bất kỳ cấu hình nào.
) else (
  echo [Thất bại] Xem thông báo bên trên. Có thể chỉ định thủ công thư mục SillyTavern:
  echo        install-loader.bat "C:\SillyTavern"
)
pause
exit /b %CODE%