#!/usr/bin/env bash
# Copies the shared owner-page files from pups-ui (next to pups-php in the PUPS repository):
# owner.css and owner.js into pups/assets/, texts.json into pups/lib/. PHP can't use the
# package directly, and the zip must work without it. tests/ui_sync_test.php checks the copies.
set -euo pipefail
cd "$(dirname "$0")/.."
ui=../pups-ui
[ -f "$ui/texts.json" ] || { echo "pups-ui not found next to pups-php" >&2; exit 1; }
cp "$ui/public/pups/assets/owner.css" "$ui/public/pups/assets/owner.js" pups/assets/
cp "$ui/texts.json" pups/lib/texts.json
echo "Copied owner.css, owner.js and texts.json from pups-ui."
