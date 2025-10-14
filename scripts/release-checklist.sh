#!/bin/bash
# 릴리즈 체크리스트 - 배포 전 실행

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}Release Checklist${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

ERRORS=0

# 1. VITE_API_BASE_URL 스냅샷
echo -e "${YELLOW}[1/6] Checking VITE_API_BASE_URL...${NC}"
if [ -f "frontend/.env.production" ]; then
    VITE_API_BASE=$(grep VITE_API_BASE_URL frontend/.env.production | cut -d '=' -f2)
    echo -e "  ${GREEN}✓${NC} VITE_API_BASE_URL=$VITE_API_BASE"
    echo "  Snapshot: $VITE_API_BASE" > .release-snapshot.txt
else
    echo -e "  ${RED}✗${NC} frontend/.env.production not found"
    ERRORS=$((ERRORS + 1))
fi

# 2. render.yaml 라우팅 확인
echo -e "${YELLOW}[2/6] Checking render.yaml routing...${NC}"
if [ -f "render.yaml" ]; then
    if grep -q "/api/:path\*" render.yaml; then
        echo -e "  ${GREEN}✓${NC} render.yaml has /api/:path* proxy rule"
    else
        echo -e "  ${RED}✗${NC} render.yaml missing /api proxy rule"
        ERRORS=$((ERRORS + 1))
    fi
    
    if grep -q "destination: /index.html" render.yaml; then
        echo -e "  ${GREEN}✓${NC} render.yaml has SPA rewrite rule"
    else
        echo -e "  ${RED}✗${NC} render.yaml missing SPA rewrite"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "  ${RED}✗${NC} render.yaml not found"
    ERRORS=$((ERRORS + 1))
fi

# 3. static.json 확인 (있는 경우)
echo -e "${YELLOW}[3/6] Checking static.json (if exists)...${NC}"
if [ -f "frontend/static.json" ]; then
    if grep -q '"/api/(.*)"' frontend/static.json; then
        echo -e "  ${GREEN}✓${NC} static.json has /api proxy rule"
    else
        echo -e "  ${RED}✗${NC} static.json missing /api proxy rule"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "  ${BLUE}ℹ${NC}  static.json not used (using render.yaml)"
fi

# 4. Django 미들웨어 확인
echo -e "${YELLOW}[4/6] Checking Django middleware...${NC}"
if [ -f "backend/config/settings.py" ]; then
    if grep -q "APINotFoundMiddleware" backend/config/settings.py; then
        echo -e "  ${GREEN}✓${NC} APINotFoundMiddleware enabled"
    else
        echo -e "  ${RED}✗${NC} APINotFoundMiddleware not found"
        ERRORS=$((ERRORS + 1))
    fi
    
    if grep -q "NoCacheAPIMiddleware" backend/config/settings.py; then
        echo -e "  ${GREEN}✓${NC} NoCacheAPIMiddleware enabled"
    else
        echo -e "  ${RED}✗${NC} NoCacheAPIMiddleware not found"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "  ${RED}✗${NC} backend/config/settings.py not found"
    ERRORS=$((ERRORS + 1))
fi

# 5. CORS 설정 확인
echo -e "${YELLOW}[5/6] Checking CORS configuration...${NC}"
if [ -f "backend/config/settings.py" ]; then
    if grep -q "CORS_ALLOW_CREDENTIALS = True" backend/config/settings.py; then
        echo -e "  ${GREEN}✓${NC} CORS_ALLOW_CREDENTIALS enabled"
    else
        echo -e "  ${YELLOW}⚠${NC}  CORS_ALLOW_CREDENTIALS not set"
    fi
    
    if grep -q "CORS_ALLOWED_ORIGINS" backend/config/settings.py; then
        echo -e "  ${GREEN}✓${NC} CORS_ALLOWED_ORIGINS configured"
    else
        echo -e "  ${RED}✗${NC} CORS_ALLOWED_ORIGINS not found"
        ERRORS=$((ERRORS + 1))
    fi
fi

# 6. 검증 스크립트 존재 확인
echo -e "${YELLOW}[6/6] Checking verification scripts...${NC}"
if [ -f "scripts/verify-deployment.js" ]; then
    echo -e "  ${GREEN}✓${NC} verify-deployment.js exists"
else
    echo -e "  ${RED}✗${NC} verify-deployment.js not found"
    ERRORS=$((ERRORS + 1))
fi

if [ -f "scripts/quick-smoke-test.sh" ]; then
    echo -e "  ${GREEN}✓${NC} quick-smoke-test.sh exists"
else
    echo -e "  ${YELLOW}⚠${NC}  quick-smoke-test.sh not found"
fi

echo ""
echo -e "${BLUE}=========================================${NC}"

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    echo -e "${GREEN}Ready for deployment.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. git push origin main"
    echo "  2. Monitor Render deployment logs"
    echo "  3. Run: bash scripts/quick-smoke-test.sh"
    echo "  4. Run: node scripts/verify-deployment.js"
    exit 0
else
    echo -e "${RED}✗ $ERRORS error(s) found!${NC}"
    echo -e "${RED}Please fix the issues before deploying.${NC}"
    exit 1
fi
