#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
echo ""
echo "  cheap-web-kvm  -  offline viewer"
echo ""
echo "  Open https://localhost:8443/ in Chrome or Edge."
echo "  The certificate is self-signed, so you will get a warning the first time."
echo ""
if [ ! -d www ]; then
    echo "  www/ is missing. Build the UI first:"
    echo "    ./sync_www.sh"
    echo ""
    exit 1
fi
go run main.go
