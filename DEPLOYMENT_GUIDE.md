# Render 배포 가이드

## 자동화 상태 ✅

이 프로젝트는 Render에서 **모든 필수 설정이 자동으로 처리**되도록 구성되어 있습니다.

### 자동 처리되는 항목들

1. **✅ 마이그레이션 자동 적용**
   - `render.yaml`의 `startCommand`에서 `python manage.py migrate` 자동 실행
   - 새로운 DB 스키마 변경사항이 자동으로 적용됩니다

2. **✅ 기존 사용자 UserProfile 자동 생성**
   - 마이그레이션 `0016_auto_20250822_0826.py`에서 자동 처리
   - 기존 사용자들에게 기본 권한이 할당됩니다

3. **✅ 권한 그룹 자동 설정**
   - `editor`, `viewer` 그룹이 자동으로 생성됩니다
   - 각 그룹에 적절한 권한이 자동으로 할당됩니다

4. **✅ 새 사용자 프로필 자동 생성**
   - Django 시그널로 새 사용자 생성 시 UserProfile 자동 생성
   - 기본 조회 권한이 자동으로 부여됩니다

## 배포 후 즉시 가능한 기능

### 권한 관리
- **Django Admin**: `/admin/injection/userprofile/`에서 사용자별 권한 수정
- **REST API**: `/api/injection/user-profiles/`에서 프로그래밍 방식 권한 관리

### 사용자 승인
- **Django Admin**: `/admin/injection/userregistrationrequest/`에서 가입 요청 관리
- **REST API**: `/api/injection/signup-requests/{id}/approve/`로 승인 처리

## 현재 권한 시스템

### 권한 종류
각 사용자는 다음 기능별로 **조회/편집 권한**을 개별 설정할 수 있습니다:

- **사출 (Injection)**: 생산 기록, 제품, 부품 스펙
- **가공 (Machining)**: 가공 관련 데이터
- **재고 (Inventory)**: 재고 조회 및 관리
- **ECO**: 설계 변경 관리

### ViewSet별 권한
- `InjectionReportViewSet` → `InjectionPermission` 
- `ProductViewSet` → `InjectionPermission`
- `PartSpecViewSet` → `InjectionPermission` 
- `EcoPartSpecViewSet` → `EcoPermission`
- `EngineeringChangeOrderViewSet` → `EcoPermission`
- `InventoryView` → `InventoryPermission`

### 권한 체크 로직
- **관리자** (`is_staff=True`): 모든 권한 보유
- **일반 사용자**: UserProfile의 권한 설정에 따라 접근 제한
- **조회 액션** (GET): `can_view_*` 권한 필요
- **편집 액션** (POST/PUT/PATCH/DELETE): `can_edit_*` 권한 필요

## 수동 설정이 필요한 경우

### 1. 기존 사용자 권한 조정
배포 후 Django Admin에서 각 사용자의 권한을 요구사항에 맞게 조정:

```
/admin/injection/userprofile/
```

### 2. 새 가입 요청 승인
사용자가 가입 신청 시 Django Admin에서 승인 및 권한 설정:

```
/admin/injection/userregistrationrequest/
```

### 3. 슈퍼유저 생성 (최초 1회만)
만약 슈퍼유저가 없다면:

```bash
python manage.py createsuperuser
```

## 권한 시스템 확인 방법

### API로 확인
```bash
# 사용자 프로필 목록
curl -H "Authorization: Bearer <token>" https://your-backend-url/api/injection/user-profiles/

# 특정 사용자 권한 확인
curl -H "Authorization: Bearer <token>" https://your-backend-url/api/injection/user-profiles/{id}/
```

### Django Admin으로 확인
1. `/admin/injection/userprofile/` - 사용자별 권한 현황
2. `/admin/auth/group/` - 권한 그룹 확인
3. `/admin/injection/userregistrationrequest/` - 가입 요청 관리

## 문제 해결

### 권한 오류가 발생하는 경우
1. 해당 사용자의 UserProfile이 생성되었는지 확인
2. 적절한 권한이 설정되었는지 확인
3. 필요시 Django Admin에서 권한 수동 조정

### 마이그레이션 문제
```bash
# 마이그레이션 상태 확인
python manage.py showmigrations

# 특정 마이그레이션 재실행 (필요시)
python manage.py migrate injection 0016 --fake
python manage.py migrate injection 0016
```

## 요약

**✅ 별도 설정 불필요** - 모든 필수 설정이 자동화되었습니다!

배포 후 바로 권한 시스템이 작동하며, Django Admin에서 사용자별 권한을 자유롭게 조정할 수 있습니다.