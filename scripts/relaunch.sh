#!/usr/bin/env bash
# Rebuild Fuse.app from the current working tree, then relaunch the desktop app.
#
#   npm run relaunch              # full rebuild (next build + voice + package), swap, reopen
#   npm run relaunch -- --no-voice  # skip recompiling the Swift voice helper (reuses the built one)
#
# The build runs FIRST while the old app keeps running, so if the build fails
# the app you have open is left untouched. Only once a fresh Fuse.app exists do
# we quit the running app, replace /Applications/Fuse.app, and open it again.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

APP="Fuse.app"
BUILT="$ROOT/dist/mac-arm64/$APP"
INSTALLED="/Applications/$APP"
VOICE=1
for arg in "$@"; do
  case "$arg" in
    --no-voice) VOICE=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "▶ Building Fuse from the current source…"
npx next build
node electron/prepare.js
if [ "$VOICE" = "1" ]; then
  node electron/build-voice.js
else
  echo "  (--no-voice) skipping Swift voice rebuild; reusing electron/voice/fuse-transcribe"
fi
npx electron-builder --mac --dir

if [ ! -d "$BUILT" ]; then
  echo "✗ Build finished but $BUILT is missing — aborting before touching the running app." >&2
  exit 1
fi

echo "▶ Quitting the running Fuse app…"
osascript -e 'quit app "Fuse"' 2>/dev/null || true
# Wait for a graceful exit (its before-quit frees the localhost port), then
# force-kill any stragglers plus the bundled Next server child so the port is free.
for _ in $(seq 1 20); do
  pgrep -f "$APP/Contents/MacOS/Fuse" >/dev/null 2>&1 || break
  sleep 0.25
done
pkill -f "$APP/Contents/MacOS/Fuse" 2>/dev/null || true
pkill -f "$APP/Contents/Resources/app/server.js" 2>/dev/null || true
sleep 0.5

echo "▶ Installing the fresh build…"
TARGET="$BUILT"
if rm -rf "$INSTALLED" 2>/dev/null && cp -R "$BUILT" "$INSTALLED" 2>/dev/null; then
  TARGET="$INSTALLED"
  echo "  updated $INSTALLED"
else
  echo "  (couldn't write /Applications — launching the fresh build straight from dist/)"
fi

echo "▶ Launching Fuse…"
open "$TARGET"
echo "✓ Done — Fuse relaunched from the latest build."
