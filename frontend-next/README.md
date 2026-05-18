# frontend-next

기존 운영 프런트를 건드리지 않고 새 구조를 검증하기 위한 별도 프런트 작업공간이다.

## 목표

- 새 `app / domains / shared` 구조 검증
- 인증, 권한 가드, 공통 레이아웃, API 계층 분리
- 조회 중심 화면부터 점진 이관

## 현재 포함 범위

- 로그인 페이지
- 앱 셸
- 권한 기반 라우팅 뼈대
- `analysis`, `production`, `inventory` 읽기 화면 골격
- 기존 Django API와 연결되는 최소 auth/http layer

## 실행

```bash
cd frontend-next
npm install
npm run dev
```

개발 서버는 `5174`, API 프록시는 `http://localhost:8000`을 사용한다.

Render에 배포된 백엔드와 같은 운영 데이터를 보면서 로컬 화면만 확인하려면 아래 명령을 사용한다.

```bash
npm run dev:render
```

이 모드는 API와 MES 호출을 모두 `https://wj-reporting.onrender.com`으로 프록시한다. 로컬 Django DB를 기준으로 확인해야 할 때는 `npm run dev:local`을 사용한다.
