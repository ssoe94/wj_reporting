#!/bin/bash
# 배포 후 API 엔드포인트 검증 스크립트

# 색상 코드
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 설정
FRONTEND_URL="${FRONTEND_URL:-https://wj-reporting.onrender.com}"
BACKEND_URL="${BACKEND_URL:-https://wj-reporting-backend.onrender.com}"
TEST_DATE="2025-10-14"

echo "========================================="
echo "API Deployment Verification"
echo "========================================="
echo "Frontend: $FRONTEND_URL"
echo "Backend:  $BACKEND_URL"
echo ""

# 테스트 함수
test_endpoint() {
    local url=$1
    local expected_status=$2
    local test_name=$3
    
    echo -n "Testing: $test_name ... "
    
    # curl로 요청 (헤더 포함)
    response=$(curl -s -w "\n%{http_code}\n%{content_type}" "$url")
    
    # 응답 분리
    body=$(echo "$response" | head -n -2)
    status=$(echo "$response" | tail -n 2 | head -n 1)
    content_type=$(echo "$response" | tail -n 1)
    
    # 상태 코드 검증
    if [ "$status" != "$expected_status" ]; then
        echo -e "${RED}FAIL${NC}"
        echo "  Expected status: $expected_status, Got: $status"
        echo "  URL: $url"
        return 1
    fi
    
    # Content-Type 검증 (JSON 확인)
    if [[ ! "$content_type" =~ "application/json" ]]; then
        echo -e "${RED}FAIL${NC}"
        echo "  Expected JSON, Got: $content_type"
        echo "  URL: $url"
        echo "  Body preview: ${body:0:200}"
        return 1
    fi
    
    # HTML 태그 감지 (프록시 실패 시)
    if [[ "$body" =~ "<html" ]] || [[ "$body" =~ "<!DOCTYPE" ]]; then
        echo -e "${RED}FAIL${NC}"
        echo "  Received HTML instead of JSON!"
        echo "  URL: $url"
        echo "  Body preview: ${body:0:200}"
        return 1
    fi
    
    echo -e "${GREEN}PASS${NC}"
    echo "  Status: $status, Content-Type: $content_type"
    return 0
}

# 테스트 실행
echo "========================================="
echo "Backend Direct Tests"
echo "========================================="

test_endpoint "$BACKEND_URL/api/health/" 200 "Health Check (Backend)"

echo ""
echo "========================================="
echo "Frontend Proxy Tests"
echo "========================================="

test_endpoint "$FRONTEND_URL/api/health/" 200 "Health Check (via Proxy)"
test_endpoint "$FRONTEND_URL/api/injection/reports/summary/?date=$TEST_DATE" 200 "Reports Summary (via Proxy)"

echo ""
echo "========================================="
echo "404 JSON Guard Tests"
echo "========================================="

test_endpoint "$FRONTEND_URL/api/this-should-not-exist" 404 "Non-existent API endpoint"
test_endpoint "$BACKEND_URL/api/invalid-path-test" 404 "Backend 404 JSON response"

echo ""
echo "========================================="
echo "Summary"
echo "========================================="
echo "Verification complete!"
echo ""
echo "If any tests failed:"
echo "1. Check render.yaml proxy configuration"
echo "2. Verify static.json routes (if used)"
echo "3. Check CORS settings in Django"
echo "4. Review Render deployment logs"
