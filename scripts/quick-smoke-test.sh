#!/bin/bash
# 빠른 스모크 테스트 - 배포 후 즉시 실행

set -e

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

FRONTEND_URL="${FRONTEND_URL:-https://wj-reporting.onrender.com}"
BACKEND_URL="${BACKEND_URL:-https://wj-reporting-backend.onrender.com}"
CURL=(curl --connect-timeout 5 --max-time 30)

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}Quick Smoke Test${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

# 1. JSON 보장
echo -e "${YELLOW}[1/5] Testing JSON responses...${NC}"

# Health check
# Render may briefly return a gateway response while replacing a healthy instance.
# Readiness gets bounded retries; a persistent failure still fails deployment.
for attempt in 1 2 3 4 5; do
    HEALTH_CT=$("${CURL[@]}" -sI "$FRONTEND_URL/api/health/" | grep -i content-type | awk '{print $2}' | tr -d '\r')
    if [[ "$HEALTH_CT" =~ "application/json" ]]; then break; fi
    if [ "$attempt" -lt 5 ]; then sleep 3; fi
done
if [[ "$HEALTH_CT" =~ "application/json" ]]; then
    echo -e "  ${GREEN}✓${NC} /api/health/ returns JSON"
else
    echo -e "  ${RED}✗${NC} /api/health/ returns $HEALTH_CT"
    exit 1
fi

# Reports summary
SUMMARY_RESPONSE=$("${CURL[@]}" -s -w "\n%{content_type}" "$FRONTEND_URL/api/injection/reports/summary/?date=2025-10-14")
SUMMARY_CT=$(echo "$SUMMARY_RESPONSE" | tail -n 1)
SUMMARY_BODY="${SUMMARY_RESPONSE%$'\n'*}"

if [[ "$SUMMARY_CT" =~ "application/json" ]] && [[ ! "$SUMMARY_BODY" =~ "<html" ]]; then
    echo -e "  ${GREEN}✓${NC} /api/injection/reports/summary/ returns JSON"
else
    echo -e "  ${RED}✗${NC} /api/injection/reports/summary/ returns $SUMMARY_CT"
    exit 1
fi

# 2. 404 JSON
echo -e "${YELLOW}[2/5] Testing 404 JSON response...${NC}"

NOT_FOUND_RESPONSE=$("${CURL[@]}" -s -w "\n%{http_code}\n%{content_type}" "$FRONTEND_URL/api/_404_check")
NOT_FOUND_STATUS=$(echo "$NOT_FOUND_RESPONSE" | tail -n 2 | head -n 1)
NOT_FOUND_CT=$(echo "$NOT_FOUND_RESPONSE" | tail -n 1)
NOT_FOUND_WITHOUT_CT="${NOT_FOUND_RESPONSE%$'\n'*}"
NOT_FOUND_BODY="${NOT_FOUND_WITHOUT_CT%$'\n'*}"

if [ "$NOT_FOUND_STATUS" = "404" ] && [[ "$NOT_FOUND_CT" =~ "application/json" ]] && [[ ! "$NOT_FOUND_BODY" =~ "<html" ]]; then
    echo -e "  ${GREEN}✓${NC} 404 returns JSON (not HTML)"
else
    echo -e "  ${RED}✗${NC} 404 check failed: status=$NOT_FOUND_STATUS, ct=$NOT_FOUND_CT"
    exit 1
fi

# 3. 캐시 헤더
echo -e "${YELLOW}[3/5] Testing cache headers...${NC}"

CACHE_HEADER=$("${CURL[@]}" -sI "$FRONTEND_URL/api/health/" | grep -i cache-control | awk '{print $2}' | tr -d '\r')
if [[ "$CACHE_HEADER" =~ "no-store" ]]; then
    echo -e "  ${GREEN}✓${NC} API responses have no-store cache header"
else
    echo -e "  ${YELLOW}⚠${NC}  Cache-Control: $CACHE_HEADER (expected no-store)"
fi

# 4. 프록시 라우팅
echo -e "${YELLOW}[4/5] Testing proxy routing...${NC}"

# API should go to backend
API_RESPONSE=$("${CURL[@]}" -s "$FRONTEND_URL/api/health/")
if [[ "$API_RESPONSE" =~ "status" ]] || [[ "$API_RESPONSE" =~ "{" ]]; then
    echo -e "  ${GREEN}✓${NC} /api/* proxied to backend"
else
    echo -e "  ${RED}✗${NC} /api/* proxy failed"
    exit 1
fi

# Non-API should serve index.html
ROOT_RESPONSE=$("${CURL[@]}" -s "$FRONTEND_URL/")
if [[ "$ROOT_RESPONSE" =~ "<html" ]] && [[ "$ROOT_RESPONSE" =~ "root" ]]; then
    echo -e "  ${GREEN}✓${NC} /* serves index.html (SPA)"
else
    echo -e "  ${RED}✗${NC} SPA routing failed"
    exit 1
fi

# 5. 백엔드 직접 접근
echo -e "${YELLOW}[5/5] Testing backend direct access...${NC}"

BACKEND_CT=$("${CURL[@]}" -sI "$BACKEND_URL/api/health/" | grep -i content-type | awk '{print $2}' | tr -d '\r')
if [[ "$BACKEND_CT" =~ "application/json" ]]; then
    echo -e "  ${GREEN}✓${NC} Backend returns JSON"
else
    echo -e "  ${RED}✗${NC} Backend returns $BACKEND_CT"
    exit 1
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}All smoke tests passed! ✓${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "Deployment is healthy and ready for use."
