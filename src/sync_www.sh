#!/bin/bash
# Build the Nuxt UI for the standalone Go server and drop it into src/www/,
# which main.go embeds.
#
# The Pages deployment is built separately by CI with a /cheap-web-kvm/ base
# URL; this build uses "/" because the Go server serves from the root.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$SCRIPT_DIR/www"

echo "Building the web UI for the offline server..."
cd "$ROOT/web"
[ -d node_modules ] || npm ci
cp "$ROOT/docs/PROTOCOL.md" public/PROTOCOL.md
NUXT_APP_BASE_URL=/ npm run generate

echo "Copying into $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/web/.output/public/." "$DEST/"

echo
echo "Done. Now run:  cd src && go build -o usbkvm . && ./usbkvm"
