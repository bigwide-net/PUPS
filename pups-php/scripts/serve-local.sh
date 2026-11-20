#!/usr/bin/env bash
# Runs PUPS locally: PHP's built-in server on 127.0.0.1:8080, and Caddy for HTTPS on port 443.
# Run scripts/setup-local.sh first. Stop with Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f Caddyfile.local ] || { echo "Run scripts/setup-local.sh first." >&2; exit 1; }

# Several workers, so that the setup checks can call the server while it answers a request.
PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8080 -t pups pups/index.php &
PHP_PID=$!
trap 'kill $PHP_PID 2>/dev/null' EXIT
caddy run --config Caddyfile.local --adapter caddyfile
