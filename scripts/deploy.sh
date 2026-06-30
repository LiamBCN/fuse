#!/bin/bash
# Build, sign with the STABLE local cert, and deploy Fuse to /Applications.
#
# Signing with a fixed self-signed identity (see setup-local-signing.sh) keeps the
# app's TCC identity constant across rebuilds, so the folders you've allowed - or
# Full Disk Access - keep working after every deploy instead of re-prompting.
#
# Usage: bash scripts/deploy.sh
set -e
cd "$(dirname "$0")/.."
CN="Fuse Local Signing"

bash scripts/setup-local-signing.sh

echo "→ packaging (.app, no DMG)…"
npm run pack

echo "→ quitting running app…"
osascript -e 'tell application "Fuse" to quit' 2>/dev/null || true
killall Fuse 2>/dev/null || true
sleep 1

echo "→ replacing /Applications/Fuse.app…"
rm -rf /Applications/Fuse.app
ditto dist/mac-arm64/Fuse.app /Applications/Fuse.app

echo "→ signing with stable identity '$CN'…"
codesign --force --deep --sign "$CN" /Applications/Fuse.app

echo "→ clearing quarantine + launching…"
xattr -dr com.apple.quarantine /Applications/Fuse.app 2>/dev/null || true
open /Applications/Fuse.app

echo "✓ deployed. designated requirement:"
codesign -d -r- /Applications/Fuse.app 2>&1 | tail -1
