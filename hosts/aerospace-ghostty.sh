#!/bin/sh
if pgrep -x ghostty >/dev/null; then
  osascript -e 'tell application "Ghostty"' \
            -e 'set cfg to new surface configuration' \
            -e 'new window with configuration cfg' \
            -e 'activate' \
            -e 'end tell'
else
  open -a Ghostty
fi
