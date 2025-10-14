#!/usr/bin/env bash
# Health check 폴링 스크립트
# Usage: bash scripts/wait-health.sh <URL> <TIMEOUT_SECONDS>

set -euo pipefail

URL="${1:?Health check URL required}"
TIMEOUT="${2:-180}"

echo "Waiting for health check: $URL"
echo "Timeout: ${TIMEOUT}s"

END=$((SECONDS + TIMEOUT))

while [ $SECONDS -lt $END ]; do
  # HTTP 상태 코드 확인
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || echo "000")
  
  if [ "$code" = "200" ]; then
    echo "✅ Health check passed (HTTP $code)"
    
    # JSON 응답인지도 확인
    content_type=$(curl -sI "$URL" 2>/dev/null | grep -i content-type | awk '{print $2}' | tr -d '\r' || echo "")
    if [[ "$content_type" =~ "application/json" ]]; then
      echo "✅ Content-Type is JSON"
    else
      echo "⚠️  Warning: Content-Type is $content_type (expected JSON)"
    fi
    
    exit 0
  fi
  
  echo "⏳ Waiting... (HTTP $code) - ${SECONDS}s elapsed"
  sleep 5
done

echo "❌ Health check timed out after ${TIMEOUT}s"
exit 1
