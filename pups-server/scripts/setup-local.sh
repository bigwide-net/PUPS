#!/usr/bin/env bash
# Sets up a local PUPS test server: TLS certificate (mkcert) and .env.
# Usage: npm run setup-local [-- <host name>]      (default: alice.pups.test)
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-alice.pups.test}"

if ! command -v mkcert >/dev/null; then
  echo "mkcert is required: 'brew install mkcert' on macOS, see https://github.com/FiloSottile/mkcert for others." >&2
  exit 1
fi

# Installs mkcert's local CA into the system and browser trust stores (may ask for your password).
mkcert -install
mkdir -p certs
mkcert -cert-file "certs/$HOST.pem" -key-file "certs/$HOST-key.pem" "$HOST"

if [ -f .env ]; then
  echo ".env exists already; left unchanged."
else
  PASSWORD="$(openssl rand -base64 18)"
  CA="$(mkcert -CAROOT)/rootCA.pem"
  sed -e "s|^PUPS_ORIGIN=.*|PUPS_ORIGIN=https://$HOST|" \
      -e "s|^PUPS_PASSWORD=.*|PUPS_PASSWORD=$PASSWORD|" \
      -e "s|^PUPS_TLS_CERT=.*|PUPS_TLS_CERT=certs/$HOST.pem|" \
      -e "s|^PUPS_TLS_KEY=.*|PUPS_TLS_KEY=certs/$HOST-key.pem|" \
      -e "s|^#PUPS_EXTRA_CA=.*|PUPS_EXTRA_CA=$CA|" \
      .env.example > .env
  echo
  echo "Created .env. Your owner password: $PASSWORD"
fi

echo
if grep -qE "^[^#]*[[:space:]]$HOST([[:space:]]|\$)" /etc/hosts; then
  echo "/etc/hosts already maps $HOST."
else
  echo "Map the host name to your computer:"
  echo "  echo '127.0.0.1 $HOST' | sudo tee -a /etc/hosts"
fi
echo
echo "Then start the server with 'npm start' and open https://$HOST/"
