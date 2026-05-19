# Rebuild Planning Docs

이 문서 묶음은 `wj_reporting`를 운영 중단 없이 정리하고, 이후 AI 서비스까지 안정적으로 붙이기 위한 기준 문서입니다.

## 문서 목록

1. `01-rebuild-strategy.md`
   - 왜 전면 재개발보다 단계적 전환이 맞는지
   - 프런트 재구축, 백엔드 정리, DB 정리, AI 연동의 경계
   - 단계별 추진 순서

2. `02-api-contract.md`
   - 새 프런트와 백엔드가 따라야 할 API 계약 원칙
   - URL, 인증, 날짜/시간, 에러 응답, 권한, read/write 분리 규칙

3. `03-definition-checklist.md`
   - 개발 전에 추가로 정의해야 할 항목
   - 화면 목록, 용어집, 권한표, 데이터 정합성 기준, 마이그레이션 기준

4. `04-screen-inventory.md`
   - 현재 프런트 라우트와 화면 구조 정리
   - 어떤 화면을 분리/유지/제거할지 판단하는 기준

5. `05-api-endpoint-matrix.md`
   - 현재 백엔드 엔드포인트를 도메인별로 정리
   - 유지/정리/분리/통합 후보를 분류하는 기준

6. `06-domain-glossary.md`
   - 핵심 업무 용어와 데이터 용어 정의
   - `part_no`, `model_code`, `business_date` 같은 기준 용어 정리

7. `07-screen-to-api-map.md`
   - 화면별 실제 API 의존성 정리
   - 현재 프런트 호출과 백엔드 계약의 불일치 지점 표시

8. `08-permissions-matrix.md`
   - 현재 권한 모델과 사용자 유형 정리
   - 프런트 경로 권한과 서버 권한 차이 정리

9. `09-data-lineage-map.md`
   - 원천 데이터, 배치 데이터, 스냅샷, 집계 데이터 흐름 정리
   - AI 연동 시 어떤 데이터를 읽어야 하는지 기준 제공

10. `10-frontend-module-boundaries.md`
   - 새 프런트엔드의 모듈 경계와 책임 분리 기준
   - 공통 영역과 도메인 영역을 어떻게 나눌지 정의

11. `11-implementation-roadmap.md`
   - 실제 구현 순서를 phase 단위로 정리
   - 프런트엔드를 언제부터 어떤 범위로 시작할지 기준 제시

12. `12-backlog.md`
   - 로드맵을 실제 작업 단위로 쪼갠 실행 백로그
   - 이번 주 바로 착수할 작업과 보류할 작업 구분

13. `13-kickoff-checklist.md`
   - 재구축을 실제 시작하기 전 확인할 체크리스트
   - 스프린트 킥오프와 초기 의사결정 점검용

14. `14-production-operations-process.md`
   - 생산 계획부터 실적/이슈 기록까지의 목표 업무 흐름
   - 사출 모니터링과 추정 CT, 생산 급감 이슈 입력 방향 정리

15. `15-production-data-contract.md`
   - 생산 계획, 실행, 모니터링, 이슈의 데이터/API 계약 정리
   - 어떤 값이 입력값이고 어떤 값이 계산값인지 구분

16. `16-injection-issue-requirements.md`
   - 사출 급감/정지 이슈 감지와 입력 요구사항 정리
   - 이슈 유형, 상태, 필수 입력 항목, MVP 범위 정의

17. `17-production-screen-flows.md`
   - 생산계획, 실행, 모니터링, 이슈 화면의 사용자 흐름 정리
   - 화면 간 이동 규칙과 구현 우선순위 정의

18. `18-production-plan-upload-dashboard-design.md`
   - 생산계획 엑셀 업로드와 일자별 대시보드 설계
   - 기존 파서/API 계약과 새 프런트 화면 구성 정리

19. `19-ai-rag-architecture.md`
   - 생산 계획, MES, 보고서 데이터를 AI가 사용할 수 있게 하는 RAG 데이터 계층 설계
   - 검색/집계/권한/근거 제공 파이프라인과 Mac Studio MLX 운영 구조 정리

20. `20-analytics-storage-visualization-design.md`
   - 분석용 `raw -> fact -> mart` 저장 계층과 보존 정책 설계
   - `/analysis`, `/production`, `/mes/monitoring`, `/inventory` 시각화 계약과 예외 중심 화면 구조 정리

21. `21-machining-mes-first-manual-reconciliation.md`
   - 가공 MES 우선 집계, 수기 보정, 선진행 생산, MES 후등록 대사 설계
   - 수기 보고와 MES 보고가 중복 계상되지 않도록 하는 데이터/화면/API 계약 정리

## 이 문서를 쓰는 이유

현재 시스템은 이미 운영 기능이 넓습니다.

- 사출
- 가공/조립
- 품질
- 재고
- 생산계획/실행
- ECO
- 권한/가입 승인

따라서 "새로 예쁘게 만들기"만 목표로 접근하면, 실제로는 화면/데이터/API/권한이 다시 얽힐 가능성이 큽니다.
이번 문서들은 다음 원칙을 지키기 위한 기준점입니다.

- 운영 중단 없이 전환한다.
- 프런트는 새로 만들되, 백엔드와 DB는 단계적으로 정리한다.
- 기존 기능을 잃지 않는다.
- AI 기능은 기존 운영 시스템과 분리하되, 데이터 계약은 공유한다.

## 권장 사용 순서

1. `01-rebuild-strategy.md`를 읽고 전체 방향을 확정
2. `02-api-contract.md`를 기준으로 새 프런트와 백엔드 작업 규칙 합의
3. `03-definition-checklist.md`를 체크하면서 빠진 정의를 채움
4. `04-screen-inventory.md`와 `05-api-endpoint-matrix.md`로 현재 상태를 인벤토리화
5. `06-domain-glossary.md`와 `07-screen-to-api-map.md`로 용어와 의존성을 고정
6. `08-permissions-matrix.md`와 `09-data-lineage-map.md`로 권한과 데이터 흐름을 확정
7. `10-frontend-module-boundaries.md`로 새 프런트 구조와 책임 경계를 고정
8. `11-implementation-roadmap.md`로 실제 착수 순서와 선행 조건을 확정
9. `12-backlog.md`로 이번 주 작업과 보류 작업을 분리
10. `13-kickoff-checklist.md`로 착수 전 누락된 기준을 점검
11. `14-production-operations-process.md`로 핵심 생산 업무 흐름을 고정
12. `15-production-data-contract.md`로 생산 데이터/API 계약을 고정
13. `16-injection-issue-requirements.md`로 사출 이슈 요구사항을 고정
14. `17-production-screen-flows.md`로 실제 화면 흐름과 전이 규칙을 고정
15. `18-production-plan-upload-dashboard-design.md`로 업로드와 일자별 대시보드 계약을 고정
16. `19-ai-rag-architecture.md`로 AI RAG 검색/집계/권한/근거 계층을 고정
17. `20-analytics-storage-visualization-design.md`로 분석 저장/시각화/예외 계층을 고정
18. `21-machining-mes-first-manual-reconciliation.md`로 가공 MES 우선 보정과 중복 방지 기준을 고정
19. 그 다음에 화면 설계, 프런트 구현, API 정리, DB 정리 시작
