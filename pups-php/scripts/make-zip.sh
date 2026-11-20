#!/usr/bin/env bash
# Packs the server for upload: the contents of pups/, without config.php and data/.
# Usage: scripts/make-zip.sh      (creates pups-php.zip in the repository root)
# Unpack it in the domain's folder, or in a folder of it for a folder installation.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f pups-php.zip
(cd pups && zip -r -X -q ../pups-php.zip . -x config.php 'data/*' '*.DS_Store')
echo "Created pups-php.zip ($(unzip -Z1 pups-php.zip | grep -vc '/$') files)."
