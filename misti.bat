@echo off
rem misti.bat - start MISTI on Windows and open it in the default browser.
rem Server logs stay in this window; close it (or Ctrl+C) to stop MISTI.
setlocal
cd /d "%~dp0"
set "URL=http://127.0.0.1:31571"

rem Find bun.exe: PATH first, then the installer's default location.
set "BUN=bun"
where bun >nul 2>&1 || set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
"%BUN%" --version >nul 2>&1 || (
  echo bun.exe not found. Install it with:
  echo   powershell -c "irm bun.sh/install.ps1 | iex"
  pause
  exit /b 1
)

if not exist ".env" (
  echo .env is missing: copy .env.example to .env and set MISTRAL_API_KEY.
  pause
  exit /b 1
)

rem Already running (e.g. started twice)? Just open the page.
curl -s -o nul "%URL%/api/usage" && (
  rundll32 url.dll,FileProtocolHandler %URL%
  exit /b 0
)

if not exist "node_modules" (
  echo Installing dependencies...
  "%BUN%" install || (
    pause
    exit /b 1
  )
)

rem Open the browser as soon as the server answers (background poll, ~30 s max).
rem ping is the sleep: timeout.exe fails without console input in a /b job.
start "" /b cmd /c "for /l %%i in (1,1,30) do (curl -s -o nul %URL%/api/usage && (rundll32 url.dll,FileProtocolHandler %URL% & exit) || ping -n 2 127.0.0.1 >nul)"

"%BUN%" server.ts

rem Reached only when the server stops: keep the window open to show why.
pause
