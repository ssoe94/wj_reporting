# 권한 매트릭스

## 1. 목적

이 문서는 현재 `wj_reporting`의 권한 구조를 정리하고, 재구축 시 어떤 기준으로 단순화/정비할지 정의한다.

목표는 아래와 같다.

1. 사용자 유형별 접근 범위를 명확히 한다.
2. 메뉴 접근, 조회, 편집, 승인 권한을 분리해서 본다.
3. 프런트 라우트 권한과 백엔드 API 권한의 차이를 드러낸다.

기준 파일:

- [backend/injection/models.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/models.py:339)
- [backend/injection/permissions.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/permissions.py:1)
- [backend/injection/admin_approvals.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/injection/admin_approvals.py:1)
- [backend/production/permissions.py](/Users/ssoe94/reporting_v2/wj_reporting/backend/production/permissions.py:1)
- [frontend/src/contexts/AuthContext.tsx](/Users/ssoe94/reporting_v2/wj_reporting/frontend/src/contexts/AuthContext.tsx:165)

## 2. 현재 권한 모델 요약

현재 권한은 크게 3층으로 보인다.

1. Django 기본 권한
   - `is_staff`

2. 앱 수준 프로필 권한
   - `can_view_injection`
   - `can_view_assembly`
   - `can_view_quality`
   - `can_view_sales`
   - `can_view_development`
   - `can_edit_injection`
   - `can_edit_assembly`
   - `can_edit_quality`
   - `can_edit_sales`
   - `can_edit_development`
   - `is_admin`

3. 특수 상태 권한
   - `is_using_temp_password`
   - `password_reset_required`
   - 현장 단말 사용자 판별 로직

## 3. 현재 동작 방식

### 3.1 서버 측 권한

서버는 `SectionPermission` 기반으로 조회/편집 권한을 나눈다.

- 조회: `can_view_*`
- 편집: `can_edit_*`
- 예외: `is_staff`는 대부분 허용

관리자 승인 계열은 `AdminOnlyPermission`으로 통제한다.

### 3.2 프런트 측 권한

프런트는 `canAccessRoute()`에서 경로 접근을 판단한다.
그런데 현재 로직상 일반 로그인 사용자도 대부분의 주요 모듈 경로를 통과시키는 구조다.

즉 현재는 아래 차이가 존재할 수 있다.

- 프런트 메뉴/경로는 열리지만
- 실제 API 호출에서 서버 권한으로 막히는 경우

이 차이는 재구축 때 꼭 줄여야 한다.

## 4. 현재 권한 항목 정의

| 권한 | 현재 의미 | 적용 범위 | 비고 |
| --- | --- | --- | --- |
| `is_staff` | Django 상위 관리자 | 전역 | 서버에서 거의 전체 허용 |
| `is_admin` | 앱 관리자 메뉴 접근 | 관리자 메뉴/승인 | `is_staff`와 별도 |
| `can_view_injection` | 사출 읽기 | 메뉴/API | 조회 권한 |
| `can_edit_injection` | 사출 쓰기 | 생성/수정/삭제 | 편집 권한 |
| `can_view_assembly` | 가공 읽기 | 메뉴/API | 조회 권한 |
| `can_edit_assembly` | 가공 쓰기 | 생성/수정/삭제 | 편집 권한 |
| `can_view_quality` | 품질 읽기 | 메뉴/API | 조회 권한 |
| `can_edit_quality` | 품질 쓰기 | 생성/수정/삭제 | 편집 권한 |
| `can_view_sales` | 재고/영업 읽기 | 메뉴/API | 조회 권한 |
| `can_edit_sales` | 재고/영업 쓰기 | 생성/수정/삭제 | 편집 권한 |
| `can_view_development` | ECO/개발 읽기 | 메뉴/API | 조회 권한 |
| `can_edit_development` | ECO/개발 쓰기 | 생성/수정/삭제 | 편집 권한 |
| `is_using_temp_password` | 임시 비밀번호 사용 중 | 로그인 후 UX | 비밀번호 변경 강제 |
| `password_reset_required` | 재설정 필요 상태 | 로그인 후 UX | 운영 정책과 연결 |

## 5. 현재 사용자 유형 해석

아래는 현재 코드 구조를 기반으로 해석한 운영상 사용자 유형이다.

| 사용자 유형 | 현재 판별 방식 | 설명 |
| --- | --- | --- |
| `staff_admin` | `user.is_staff = true` | Django 상위 관리자 |
| `app_admin` | `profile.is_admin = true` | 관리자 메뉴와 승인 기능 접근 가능 |
| `module_editor` | 특정 `can_edit_* = true` | 모듈 편집 담당자 |
| `viewer` | 특정 `can_view_* = true` | 조회 전용 사용자 |
| `field_terminal` | username 패턴 기반 판별 | 현장 단말 전용 사용자 |
| `pending_signup` | UserRegistrationRequest 상태 | 가입 승인 대기 사용자 |

## 6. 모듈별 권한 매트릭스

## 6.1 운영 모듈

| 모듈 | 조회 권한 | 편집 권한 | 관리자/승인 |
| --- | --- | --- | --- |
| 사출 | `can_view_injection` | `can_edit_injection` | `is_admin` 또는 `is_staff` |
| 가공 | `can_view_assembly` | `can_edit_assembly` | `is_admin` 또는 `is_staff` |
| 품질 | `can_view_quality` | `can_edit_quality` | `is_admin` 또는 `is_staff` |
| 재고/영업 | `can_view_sales` | `can_edit_sales` | `is_admin` 또는 `is_staff` |
| ECO/개발 | `can_view_development` | `can_edit_development` | `is_admin` 또는 `is_staff` |

## 6.2 관리자 기능

| 기능 | 현재 필요 권한 | 비고 |
| --- | --- | --- |
| 가입 요청 조회 | `is_admin` 또는 `is_staff` | admin approvals |
| 가입 승인 | `is_admin` 또는 `is_staff` | 임시 비밀번호 발급 포함 |
| 가입 거절 | `is_admin` 또는 `is_staff` | 승인 상태 변경 |
| 사용자 프로필 수정 | `is_admin` 또는 `is_staff` | 권한 변경 |
| 비밀번호 초기화 | `is_admin` 또는 `is_staff` | admin endpoint |

## 6.3 생산 계획 권한

생산 계획은 별도 permission 로직을 가진다.

현재 동작:

- 조회: 로그인 사용자면 `plan_type`이 유효할 경우 허용
- 편집:
  - `is_staff` 허용
  - `is_admin` 허용
  - `plan_type=injection`이면 `can_edit_injection`
  - `plan_type=machining`이면 `can_edit_assembly`

즉 현재 생산 계획 조회는 비교적 넓고, 편집은 모듈 편집 권한에 묶여 있다.

## 7. 현재 구조의 문제점

### 7.1 프런트 경로 접근과 서버 권한이 완전히 일치하지 않음

현재 프런트는 일반 사용자의 `/injection`, `/assembly`, `/quality`, `/sales`, `/eco2`, `/models` 경로 접근을 비교적 넓게 허용한다.
하지만 서버는 실제 쓰기/읽기 권한을 프로필 플래그로 판단한다.

이 때문에 사용자 경험상 아래 문제가 생길 수 있다.

- 페이지는 열림
- API 호출에서 403 발생
- 사용자 입장에서는 "왜 보이는데 안 되지?" 상태가 생김

### 7.2 capability 모델이 아니라 화면/모듈 플래그 중심

현재는 모듈 단위 권한이 주축이다.
하지만 장기적으로는 아래 같은 세분화가 필요할 수 있다.

- `quality.report.read`
- `quality.report.write`
- `quality.supplier.manage`
- `admin.user.approve`
- `inventory.snapshot.run`

### 7.3 현장 단말 권한이 명시적 role이 아님

현재는 username 기반 판별 성격이 있어 보인다.
재구축에서는 별도 role 또는 `station_mode` capability로 명시하는 편이 안전하다.

## 8. 권장 차기 권한 모델

재구축에서는 아래 4계층 구조를 권장한다.

### 8.1 Role

예시:

- `super_admin`
- `app_admin`
- `production_editor`
- `quality_editor`
- `inventory_editor`
- `viewer`
- `field_terminal`

### 8.2 Capability

예시:

- `injection.read`
- `injection.write`
- `assembly.read`
- `assembly.write`
- `quality.read`
- `quality.write`
- `inventory.read`
- `inventory.write`
- `eco.read`
- `eco.write`
- `admin.users.approve`
- `admin.users.manage`
- `inventory.snapshot.run`
- `monitoring.refresh.run`

### 8.3 Route Access

프런트는 capability 기반으로 메뉴와 라우트를 노출한다.

### 8.4 API Access

백엔드는 동일 capability 기반으로 실제 접근을 제어한다.

## 9. 권장 사용자 유형 매트릭스

| 역할 | 사출 | 가공 | 품질 | 재고 | ECO | 관리자 | 현장 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `super_admin` | 읽기/쓰기 | 읽기/쓰기 | 읽기/쓰기 | 읽기/쓰기 | 읽기/쓰기 | 전체 | 선택 |
| `app_admin` | 읽기 | 읽기 | 읽기 | 읽기 | 읽기 | 승인/권한관리 | 아니오 |
| `production_editor` | 읽기/쓰기 | 읽기/쓰기 | 읽기 | 읽기 | 읽기 | 아니오 | 아니오 |
| `quality_editor` | 읽기 | 읽기 | 읽기/쓰기 | 읽기 | 읽기 | 아니오 | 아니오 |
| `inventory_editor` | 읽기 | 읽기 | 읽기 | 읽기/쓰기 | 읽기 | 아니오 | 아니오 |
| `viewer` | 읽기 | 읽기 | 읽기 | 읽기 | 읽기 | 아니오 | 아니오 |
| `field_terminal` | 제한적 작업 | 제한적 작업 | 아니오 | 아니오 | 아니오 | 아니오 | 전용 |

## 10. 재구축 시 바로 해야 할 권한 작업

1. 프런트 메뉴 노출 규칙과 서버 권한을 맞춘다.
2. `field_terminal`을 명시적 role/capability로 승격한다.
3. 관리자 권한과 staff 권한의 차이를 문서화한다.
4. 생산 계획 권한을 별도 capability로 분리할지 결정한다.
5. 배치성 action API 실행 권한을 별도로 만든다.

## 11. 다음 작업 추천

이 문서 다음으로 가장 유용한 작업은 아래다.

1. `data-lineage-map.md`
2. `frontend-module-boundaries.md`
3. `capability-catalog.md`
