#!/usr/bin/env bash
set -euo pipefail

site_url="${1:?site URL is required}"
expected_commit="${2:?expected commit is required}"
expected_branch="${3:?expected branch is required}"
timeout_seconds="${4:-300}"
interval_seconds=10
deadline=$((SECONDS + timeout_seconds))

while (( SECONDS < deadline )); do
  response=$(curl -fsS \
    -H 'Cache-Control: no-cache' \
    "${site_url}/build-info.json?expected=${expected_commit}&attempt=${SECONDS}" 2>/dev/null || true)
  deployed_commit=$(printf '%s' "$response" | jq -r '.commit // empty' 2>/dev/null || true)
  deployed_branch=$(printf '%s' "$response" | jq -r '.branch // empty' 2>/dev/null || true)

  echo "Waiting for ${site_url}: branch=${deployed_branch:-missing} commit=${deployed_commit:-missing}"

  if [[ "$deployed_commit" == "$expected_commit" && "$deployed_branch" == "$expected_branch" ]]; then
    echo "Verified ${expected_branch}@${expected_commit} on ${site_url}."
    exit 0
  fi

  sleep "$interval_seconds"
done

echo "::error::Timed out waiting for ${expected_branch}@${expected_commit} on ${site_url}."
exit 1
