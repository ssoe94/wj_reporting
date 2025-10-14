#!/bin/bash
# 유용한 원라이너 모음

# JSON 아닌 응답 잡아내기
curl -sI https://wj-reporting.onrender.com/api/health/ | grep -i content-type

# JSON 파싱 테스트
curl -s https://wj-reporting.onrender.com/api/injection/reports/summary/?date=2025-10-14 | jq .

# 404도 JSON인지 확인
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://wj-reporting.onrender.com/api/_404_check

# 모든 헤더 확인
curl -I https://wj-reporting.onrender.com/api/health/

# 응답 시간 측정
curl -w "@-" -o /dev/null -s https://wj-reporting.onrender.com/api/health/ <<'EOF'
    time_namelookup:  %{time_namelookup}\n
       time_connect:  %{time_connect}\n
    time_appconnect:  %{time_appconnect}\n
      time_redirect:  %{time_redirect}\n
   time_pretransfer:  %{time_pretransfer}\n
 time_starttransfer:  %{time_starttransfer}\n
                    ----------\n
         time_total:  %{time_total}\n
EOF

# 쿠키 포함 요청
curl -b "sessionid=test" https://wj-reporting.onrender.com/api/health/

# POST 요청 테스트
curl -X POST -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}' \
  https://wj-reporting-backend.onrender.com/api/token/

# 인증 토큰 포함 요청
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://wj-reporting.onrender.com/api/injection/reports/

# 여러 엔드포인트 한번에 테스트
for endpoint in health injection/reports/summary; do
  echo "Testing /api/$endpoint"
  curl -sI "https://wj-reporting.onrender.com/api/$endpoint" | grep -i content-type
done
