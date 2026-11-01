#!/bin/bash
# misti.command - start MISTI on macOS and open it in the default browser.
# Double-click in Finder (opens Terminal); server logs stay in this window.
# Close the window (or Ctrl+C) to stop MISTI.
set -u
cd "$(dirname "$0")"
URL=http://127.0.0.1:31571

rem_paused() {
  echo
  read -r -p "Press Return to close this window... " _
  exit 1
}

# Find bun: PATH first, then the installer's default location.
BUN=bun
command -v bun >/dev/null 2>&1 || BUN="$HOME/.bun/bin/bun"
"$BUN" --version >/dev/null 2>&1 || {
  echo "bun not found. Install it with:"
  echo '  curl -fsSL https://bun.sh/install | bash'
  rem_paused
}

# Double-click doesn't put ~/.bun on PATH: bun's own 'bunx'/'node' lookups
# and any child processes may need it too.
case ":$PATH:" in
  *":$HOME/.bun/bin:"*) ;;
  *) export PATH="$HOME/.bun/bin:$PATH" ;;
esac

if [ ! -f .env ]; then
  echo ".env is missing: copy .env.example to .env and set MISTRAL_API_KEY."
  rem_paused
fi

# Already running (e.g. started twice)? Just open the page.
curl -sf -o /dev/null "$URL/api/usage" && {
  open "$URL"
  exit 0
}

# Close any stale lock/breakage: no port check needed, server binds and dies loudly.
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  "$BUN" install || rem_paused
fi

# Open the browser as soon as the server answers (background poll, ~30 s max).
(
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "$URL/api/usage" && { open "$URL"; exit; }
    sleep 1
  done
) &

"$BUN" server.ts

# Reached only when the server stops: keep the window open to show why.
echo "Server stopped."
read -r -p "Press Return to close this window... " _
