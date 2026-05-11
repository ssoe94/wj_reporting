# API 계약 원칙

## 1. 목적

새 프런트와 정리된 백엔드가 함께 오래 가려면, API는 "작동하는 것"보다 "예측 가능한 것"이 더 중요하다.

이 문서는 `wj_reporting` 재구축 시 적용할 API 계약 원칙을 정의한다.

## 2. 현재 상태에서 보이는 이슈

현재 API는 이미 많은 기능을 제공하지만, 장기적으로는 아래 문제가 생기기 쉽다.

- 도메인별 엔드포인트 구조는 있으나 성격이 혼재되어 있다.
- 일부 기능은 같은 자원인데 조회/집계/업로드가 분리 기준 없이 추가되었다.
- 권한 판단이 프런트와 백엔드에 나뉘어 있다.
- 시간대와 business date 기준이 계약으로 명확히 드러나지 않는다.
- 레거시 호환 필드가 타입에 남아 있다.

## 3. 최상위 원칙

1. API는 서버가 진실의 원천이다.
2. 프런트는 서버 응답을 해석하지만, 업무 규칙을 재정의하지 않는다.
3. write API와 read API는 구분한다.
4. 대시보드/집계 API는 목록 API와 분리한다.
5. 날짜, 시간, 권한, 에러 형식은 전 모듈에서 공통 규칙을 쓴다.
6. AI 서비스는 같은 계약을 읽기 전용으로 재사용한다.

## 4. 권장 URL 구조

장기적으로는 `/api/v1/` 기준으로 정리하는 것을 권장한다.

예시:

```text
/api/v1/auth/...
/api/v1/users/...
/api/v1/injection/...
/api/v1/assembly/...
/api/v1/quality/...
/api/v1/inventory/...
/api/v1/production/...
/api/v1/eco/...
/api/v1/analytics/...
```

초기에는 기존 `/api/...`를 유지해도 되지만, 새 프런트 전용 계층은 가능하면 `v1` 기준으로 준비하는 편이 좋다.

## 5. 자원 분류 원칙

각 도메인의 엔드포인트는 아래 4개 범주로 나눈다.

### 5.1 Master

변동이 상대적으로 적고 기준이 되는 데이터

- parts
- products
- suppliers
- machines
- lines
- users
- permissions

### 5.2 Transaction

사용자가 생성/수정하는 운영 데이터

- injection reports
- assembly reports
- quality reports
- production executions
- eco records

### 5.3 Snapshot

특정 시점 기준으로 수집/고정되는 데이터

- inventory snapshots
- finished goods transaction snapshots
- MES sync records

### 5.4 Analytics

집계/요약/차트용 데이터

- dashboard summaries
- OEE
- downtime analysis
- production status
- quality daily attention

## 6. API naming 규칙

### 리소스명

- 복수형 사용
- 소문자 kebab-case 또는 snake_case 중 하나로 통일
- 약어보다 업무 용어 우선

권장 예시:

- `/parts`
- `/production-plans`
- `/production-executions`
- `/quality-reports`

### 액션성 엔드포인트

정말 필요한 경우에만 사용

권장 예시:

- `POST /production-plans:upload`
- `POST /inventory-snapshots:create`
- `POST /mes-sync:run`

초기에는 기존 경로를 유지하더라도, 새 계약 문서에서는 액션임을 명확히 표기한다.

## 7. 응답 구조 규칙

### 7.1 단건 조회

```json
{
  "data": {
    "id": 1
  }
}
```

### 7.2 목록 조회

```json
{
  "data": [
    {
      "id": 1
    }
  ],
  "meta": {
    "count": 1,
    "page": 1,
    "page_size": 50
  }
}
```

### 7.3 에러 응답

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request.",
    "fields": {
      "part_no": [
        "This field is required."
      ]
    }
  }
}
```

현재 DRF 기본 응답을 바로 쓰더라도, 새 프런트 전환 구간에서는 어댑터 계층으로 이 형식에 가깝게 맞추는 것이 좋다.

## 8. 날짜/시간 계약

이 항목은 반드시 조기에 확정해야 한다.

### 저장

- DB 저장은 UTC

### 전송

- datetime은 ISO 8601 사용
- 예: `2026-05-09T08:30:00Z`

### 표시

- 프런트는 사용자/사업장 기준 시간대로 표시

### business date

- 별도 필드 또는 별도 정의가 필요하다.
- 예: 오전 08:00 이전 데이터는 전일 생산일로 간주

주의:

- `date`
- `report_dt`
- `plan_date`
- `snapshot_date`
- `business_date`

이 다섯 개는 의미가 다르므로 문서에서 구분해야 한다.

## 9. 인증/권한 계약

### 인증

- JWT 유지 가능
- 단, 새 프런트에서는 인증 상태와 사용자 프로필 응답 계약을 명확히 고정

권장 기본 엔드포인트:

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /users/me`

### 권한

사용자 정보 응답은 단순 프로필이 아니라 `capabilities` 중심으로 내려주는 편이 좋다.

권장 예시:

```json
{
  "data": {
    "id": 1,
    "username": "user1",
    "display_name": "홍길동",
    "department": "QA",
    "roles": ["quality_editor"],
    "capabilities": {
      "quality.read": true,
      "quality.write": true,
      "production.read": false,
      "admin.users.approve": false
    }
  }
}
```

기존 `can_view_*`, `can_edit_*`, `is_admin` 구조는 당장 유지할 수 있지만, 새 계약에서는 capability 기반으로 매핑 테이블을 두는 것이 좋다.

## 10. 프런트에서 금지할 것

아래 규칙은 프런트에서 하지 않는 것을 원칙으로 한다.

- 권한 임의 추론
- business date 임의 계산
- 서버 계산값 재계산 후 저장
- 레거시 필드와 신규 필드의 의미 결정
- API별 예외 규칙 하드코딩

프런트는 최대한 표시와 입력 보조에 집중해야 한다.

## 11. 도메인별 핵심 계약 초안

### 11.1 Parts

목표:

- 모든 모듈이 공통으로 참조할 품목 기준 정의

최소 필드:

- `part_no`
- `model_code`
- `description`
- `source_system`
- `is_active`
- `valid_from`

### 11.2 Injection Reports

구분:

- 입력 레코드
- 분석 집계

분리 예시:

- `GET /injection-reports`
- `POST /injection-reports`
- `GET /analytics/injection/oee`
- `GET /analytics/injection/downtime`

### 11.3 Assembly Reports

주의:

- JSON 불량 상세 구조를 계약으로 먼저 고정해야 한다.
- 자유형 JSON이면 프런트 재구축 때 다시 혼란이 생긴다.

### 11.4 Quality Reports

주의:

- 이미지 업로드 메타데이터와 본문 데이터 분리
- 첨부 이미지 개수 제한/순서/필수 여부 명시
- `judgement`, `section` 값 enum 고정

### 11.5 Inventory

주의:

- 실시간 재고
- 일일 스냅샷
- 이메일 보고용 요약

이 세 가지는 별도 자원으로 분리해서 문서화해야 한다.

### 11.6 Production

주의:

- 계획
- 실행
- MES 실적
- 대시보드 집계

이 네 층을 구분하지 않으면 이후 AI나 통계 쿼리에서 계속 헷갈리게 된다.

## 12. AI 연동을 위한 API 원칙

AI 서비스는 별도 시스템으로 두되, API 계약은 공통으로 가져간다.

권장 원칙:

- AI는 read-only API만 사용
- 대시보드용 요약 API와 원장성 상세 API를 구분
- 자연어 응답용으로 근거 링크/레코드 id를 함께 반환할 수 있게 설계
- AI 전용 집계 API는 기존 운영 API와 분리

예시:

- `GET /api/v1/ai-context/production-daily-summary`
- `GET /api/v1/ai-context/quality-issues`
- `GET /api/v1/ai-context/eco-impact`

## 13. deprecated 정책

기존 API를 바로 없애지 말고 아래 정책을 따른다.

1. 새 API 추가
2. 프런트 일부 전환
3. 운영 검증
4. deprecated 표시
5. 전체 전환 후 제거

문서에는 각 API에 대해 아래 상태를 표시한다.

- `active`
- `legacy`
- `deprecated`
- `planned`

## 14. 다음 단계

이 문서를 바탕으로 이어서 해야 할 일은 아래다.

1. 실제 엔드포인트 목록 표 만들기
2. 각 엔드포인트를 master/transaction/snapshot/analytics로 분류
3. 유지/개선/폐기 후보 표시
4. 새 프런트에서 먼저 사용할 API 집합 확정
