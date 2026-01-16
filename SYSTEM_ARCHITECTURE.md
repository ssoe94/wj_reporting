# WJ Reporting System - Architecture & Feature Map

이 문서는 시스템의 전체 구조, 기능별 모듈 구성, 그리고 개발 시 준수해야 할 명명 규칙을 정리한 가이드입니다.

## 1. 시스템 모듈 구조 (Module Map)

시스템은 크게 **사출(Injection)**, **가공/조립(Assembly/Machining)**, **품질(Quality)**, **생산계획(Production)** 모듈로 나뉩니다.

### 🏭 사출 (Injection)
- **Backend App**: `injection`
- **Frontend Pages**: `pages/summary` (실제 기록/현황), `pages/injection` (설정/모니터링)
- **핵심 기능**:
  - 사출 생산 기록 관리 (`InjectionReport`)
  - 사출기 파라미터 모니터링 (`InjectionMonitoringRecord`)
  - 사이클 타임 설정 및 승인 프로세스 (`CycleTimeSetup`, `CycleTimeTestRecord`)
  - 금형/사출 스펙 관리 (`PartSpec`)

### 🛠️ 가공/조립 (Assembly/Machining)
- **Backend App**: `assembly`
- **Frontend Pages**: `pages/assembly`
- **핵심 기능**:
  - 가공 생산 기록 관리 (`AssemblyReport`)
  - 불량 유형 히스토리 관리 (`DefectHistory`)
- **참고**: 코드상에서는 `assembly`를 사용하지만, 사용자 UI에서는 주로 **'가공'** 또는 **'Machining'**으로 표기됩니다.

### 🛡️ 품질 (Quality)
- **Backend App**: `quality`
- **Frontend Pages**: `pages/quality`
- **핵심 기능**:
  - 공정/입고/출하 품질 보고 (`QualityReport`)
  - 불량 이미지 업로드 (Cloudinary 연동)
  - IQC 공급자 관리 (`Supplier`)

### 📅 생산 및 공통 (Production & Core)
- **Backend Apps**: `production`, `injection` (일부 공통 모델 포함)
- **핵심 기능**:
  - **생산 계획**: `production/models.py` (`ProductionPlan`) - 사출/가공 공통 계획 관리
  - **ECO**: `injection/models.py` (`EngineeringChangeOrder`, `EcoPartSpec`) - 설계 변경 관리
  - **인증/권한**: `injection/models.py` (`UserProfile`, `UserRegistrationRequest`) - RBAC 및 가입 승인
  - **제품 마스터**: `injection/models.py` (`Product`) - 완제품/반제품 파트넘버 맵핑

## 2. 명명 규칙 (Nomenclature)

### Backend (Django)
- **App Names**: 소문자 (예: `injection`, `assembly`)
- **Model Names**: PascalCase (예: `InjectionReport`, `AssemblyReport`)
- **Field Names**: snake_case (예: `part_no`, `plan_qty`)
- **Part No Normalization**: 모든 생산 관련 모델은 `save()` 메서드에서 `part_no`를 자동으로 **대문자(Upper Case)**로 변환합니다.

### Frontend (React/TypeScript)
- **Page Components**: `pages/` 디렉토리 하위에 위치하며 PascalCase 사용.
- **Components**: `components/` 디렉토리에 위치.
- **Routes (App.tsx)**:
  - `/injection`: 사출 현황 및 기록
  - `/assembly`: 가공 현황 및 기록
  - `/production`: 생산 계획 및 통계
  - `/eco2`: ECO 관리 (이전 `/eco`에서 업그레이드됨)

## 3. 데이터베이스 중요 필드 설명

- **part_no**: 시스템 전체에서 품목을 식별하는 주요 키.
- **section**: 사출 모듈에서는 `C/A`, `B/C`, `COVER` 등으로 구분하며, 품질 모듈에서는 `LQC_INJ`, `IQC` 등으로 보고 단계를 구분합니다.
- **tonnage**: 사출기의 형체력(T)을 나타냅니다.

## 4. UI 및 API 매핑 (UI & API Mapping)

### UI Component Map

| Component | Page/Module | Purpose | Key API / Data |
| :--- | :--- | :--- | :--- |
| `MachineSetupModal` | Injection > Setup | 사출기 설정 수정 | `api/injection/setup/` |
| `EcoViewModal` | ECO | ECO 상세 정보 조회 | `api/injection/ecos/` |
| `EcoForm` | ECO | ECO 생성/수정 | `api/injection/ecos/` |
| `RecordForm` | Injection > New | 생산 실적 입력 | `api/injection/reports/` |
| `QualityReportForm` | Quality | 품질 검사 결과 입력 | `api/quality/reports/` |
| `CartDetailModal` | Sales > Daily Report | 재고 카트 상세 정보 | `api/inventory/daily-report/` |
| `ProgressModal` | Sales > Inventory | 재고 스냅샷 생성 진행률 | `api/inventory/snapshot/create/` |

### API Endpoint Mapping

프론트엔드 API 클라이언트는 `frontend/src/lib/api.ts`에 정의되어 있으며, 주요 엔드포인트는 다음과 같습니다.

#### 사출 (Injection)
- **생산 실적**: `GET|POST|PUT|DELETE` `/api/injection/reports/`
- **사출기 설정**: `GET|POST|PUT|DELETE` `/api/injection/setup/`
- **모니터링 데이터**: `GET` `/api/injection/monitoring-data/`

#### ECO 관리
- **ECO 데이터**: `GET|POST|PUT|DELETE` `/api/ecos/`
- **관련 품목**: `GET` `/api/eco-parts/`

#### 가공 (Assembly)
- **가공 실적**: `GET|POST|PUT|DELETE` `/api/assembly/reports/`

#### 품질 (Quality)
- **품질 보고서**: `GET|POST|PUT|DELETE` `/api/quality/reports/`
- **공급사 목록**: `GET` `/api/quality/suppliers/`

#### 재고 및 영업 (Inventory & Sales)
- **현재고 현황**: `GET` `/api/inventory/status/`
- **일일 재고 보고서**: `GET` `/api/inventory/daily-report/`
- **통합 품목 검색**: `GET` `/api/inventory/unified-parts/search/`

---

## 5. 기타 개발 가이드

- **환경 변수**: 프론트엔드는 `VITE_` 접두사를 사용해야 하며, 백엔드는 `.env`를 통해 민감 정보를 관리합니다.
- **이미지 처리**: 품질 보고서의 이미지는 백엔드에서 서명을 받아 프론트엔드에서 Cloudinary로 직접 업로드합니다.
- **권한 체크**: `User.is_staff`는 모든 권한을 가지며, 일반 사용자는 `UserProfile`에 설정된 권한에 따라 메뉴와 기능 접근이 제한됩니다.

---
*(마지막 업데이트: 2026-01-06)*
