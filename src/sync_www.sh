#!/bin/bash
# Copy the web UI from the repository root into src/www/ so the Go binary can
# embed it. The root is the single source of truth: GitHub Pages serves it
# directly, so nothing needs copying for the hosted build.
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$SCRIPT_DIR/www"

echo "Syncing web UI: $ROOT -> $DEST"

rm -rf "$DEST"
mkdir -p "$DEST"

for f in index.html app.css ui-kit.js local-kvm.js favicon.png \
         paste-box.html paste-box.js \
         copy-box.html copy-box.js \
         onscreen-keyboard.html onscreen-keyboard.js \
         quick-access.html quick-access.js \
         screen-recorder.html settings.html; do
    cp "$ROOT/$f" "$DEST/$f"
done


cp -R "$ROOT/scripts" "$DEST/scripts"

echo "Done. Now run: cd src && go build"
