@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=C:\Users\Surya\AppData\Local\OpenAI\Codex\bin\node.exe"

if not exist "%NODE_EXE%" (
  echo Could not find the bundled Node runtime:
  echo %NODE_EXE%
  echo.
  echo Install Node.js or open this app from Codex again.
  pause
  exit /b 1
)

echo Starting MotoRoute Studio...
echo.
"%NODE_EXE%" "%~dp0server.js" --open
echo.
echo The server stopped. If the app did not open, tell Codex the message shown above.
pause
