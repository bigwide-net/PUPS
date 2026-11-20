#!/usr/bin/env bash
# Sets up PUPS for local tests: a TLS certificate (mkcert), pups/config.php and Caddyfile.local.
# Usage: scripts/setup-local.sh [<host name>]      (default: alice-php.pups.test)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-alice-php.pups.test}"

for tool in mkcert caddy php; do
  if ! command -v "$tool" >/dev/null; then
    echo "$tool is required: 'brew install $tool' on macOS (see README.md for other systems)." >&2
    exit 1
  fi
done

# Installs mkcert's local CA into the system and browser trust stores (may ask for your password).
mkcert -install
mkdir -p certs
mkcert -cert-file "certs/$HOST.pem" -key-file "certs/$HOST-key.pem" "$HOST"

if [ -f pups/config.php ]; then
  echo "pups/config.php exists already; left unchanged."
else
  SECRET="$(openssl rand -base64 24)"
  CA="$(mkcert -CAROOT)/rootCA.pem"
  cat > pups/config.php <<CONFIG
<?php
// Local test configuration, written by scripts/setup-local.sh. See config.example.php.
return [
    'origin' => 'https://$HOST',
    'setup_secret' => '$SECRET',
    // A test app on this computer (e.g. https://app.pups.test -> 127.0.0.1) may be a client.
    'allow_private_clients' => true,
    'extra_ca' => '$CA',
];
CONFIG
  echo
  echo "Created pups/config.php. Your setup secret: $SECRET"
fi

# Caddy terminates TLS on port 443 and passes requests on to PHP's built-in server.
cat > Caddyfile.local <<CADDY
{
	auto_https disable_redirects
	admin off
}

https://$HOST {
	tls certs/$HOST.pem certs/$HOST-key.pem
	reverse_proxy 127.0.0.1:8080
}
CADDY

echo
if grep -qE "^[^#]*[[:space:]]$HOST([[:space:]]|\$)" /etc/hosts; then
  echo "/etc/hosts already maps $HOST."
else
  echo "Map the host name to your computer:"
  echo "  echo '127.0.0.1 $HOST' | sudo tee -a /etc/hosts"
fi
echo
echo "Then start the server with 'scripts/serve-local.sh' and open https://$HOST/pups/setup"
