#!/usr/bin/env bash
set -euo pipefail

keychain_service="${AI_WORKER_KEYCHAIN_SERVICE:-com.wj.local-ai-worker.token}"
keychain_account="${AI_WORKER_KEYCHAIN_ACCOUNT:-$(id -un)}"

worker_token="$(/opt/homebrew/bin/openssl rand -hex 32)"
/usr/bin/security add-generic-password \
  -U \
  -a "$keychain_account" \
  -s "$keychain_service" \
  -w "$worker_token" >/dev/null

printf '%s' "$worker_token" | /usr/bin/pbcopy
unset worker_token

echo "A new AI Worker token is stored in macOS Keychain and copied to the clipboard."
echo "Add the clipboard value as AI_WORKER_TOKEN in the Render shared-secrets environment group."
