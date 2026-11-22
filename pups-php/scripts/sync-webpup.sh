#!/usr/bin/env bash
# Builds webpup (next to pups-php in the PUPS repository) and copies it into pups/webpup/, from
# where the homepage page (/pups/homepage) installs it at the domain root. The zip must work
# without the webpup sources, so the build is part of pups-php.
set -euo pipefail
cd "$(dirname "$0")/.."
wp=../webpup
[ -f "$wp/package.json" ] || { echo "webpup not found next to pups-php" >&2; exit 1; }
(cd "$wp" && npm run build --silent)
rm -rf pups/webpup
cp -R "$wp/dist" pups/webpup
echo "Copied webpup ($(find pups/webpup -type f | wc -l | tr -d ' ') files) into pups/webpup/."
