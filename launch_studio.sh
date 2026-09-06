#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Start server if not running
if ! pgrep -f "$DIR/server.py" > /dev/null 2>&1; then
    nohup /usr/bin/python3 "$DIR/server.py" > "$DIR/server.log" 2>&1 &
fi
