#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Start server if not running
if ! pgrep -f "$DIR/server.py" > /dev/null 2>&1; then
    nohup /usr/bin/python3 "$DIR/server.py" > "$DIR/server.log" 2>&1 &
    sleep 0.5
fi

# Open browser
if command -v chromium >/dev/null 2>&1; then
    chromium "http://localhost:8080" >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:8080" >/dev/null 2>&1 &
fi
