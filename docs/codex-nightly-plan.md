# Codex Worktree Nightly Plan

## 전제

Cloud task는 이번 단계에서 사용하지 않는다.

야간 작업은 Codex App Worktree 모드 또는 별도 git worktree에서 진행한다.

추천 설정:

- Mode: `Worktree`
- Branch name: `codex/nightly-ai-rag-p1`
- 작업 대상: backend AI 계산형 RAG 파이프라인

원본 `main` 작업트리는 사람이 검토하는 공간으로 남기고, 야간 실험은 워크트리에서 진행한다.

## 목적

퇴근 후 Codex 앱을 켜둔 상태에서 P1 계산형 RAG를 조금씩 안정화한다.

지금의 목표는 문서 RAG, 벡터 DB, Mac Studio LLM 연결이 아니다. 먼저 생산 대시보드 AI 브리핑과 계산형 답변의 백엔드 데이터 계층을 작고 검증 가능한 단위로 정리한다.

## 현재 기준

이미 구현된 P1 v1:

- `backend/production/ai_types.py`
- `backend/production/ai_metrics.py`
- `backend/production/ai_retrievers.py`
- `backend/production/ai_context.py`
- `backend/production/ai_answer.py`
- `GET /api/production/ai/briefing/`
- 생산 대시보드의 AI 브리핑 카드 endpoint 연결 및 fallback

따라서 야간 작업은 위 파일을 다시 크게 갈아엎는 것이 아니라, 검증/정리/테스트/작은 보강 중심으로 진행한다.

## Worktree 안전 규칙

- worktree 내부에서 `git status --short`를 먼저 확인한다.
- unrelated dirty file은 건드리지 않는다.
- `.env`, credentials, deployment 설정은 수정하지 않는다.
- migration은 생성하지 않는다.
- production DB 접속이 필요하면 멈추고 요약한다.
- 배포하지 않는다.
- main에 직접 commit하지 않는다.
- commit, push, PR 생성은 명시 요청 없이는 하지 않는다.
- 자동 merge하지 않는다.
- 대규모 리팩터링은 하지 않는다.
- 두 번 이상 빌드/검증 실패가 나면 더 고치지 말고 원인과 다음 액션을 요약한다.

## 야간 작업 우선순위

### Night A. P1 브리핑 v1 검증

목표:

- 현재 구현된 `/api/production/ai/briefing/`의 계산 기준과 응답 schema를 검토한다.
- deterministic briefing이 LLM 없이 정상 작동하는지 확인한다.
- 프런트 fallback이 깨지지 않는지 확인한다.

작업:

- `ai_types.py`, `ai_metrics.py`, `ai_retrievers.py`, `ai_context.py`, `ai_answer.py` 구조 검토
- endpoint 응답 schema가 `docs/rebuild/19-ai-rag-architecture.md`의 P1 MVP와 맞는지 확인
- 가능한 범위에서 unit/smoke test 또는 lightweight check 추가
- `python3 -m py_compile ...` 실행
- frontend 변경이 있으면 `npm run build` 실행

금지:

- `ai_router.py` 구현 시작 금지
- 문서 RAG 시작 금지
- LLM rewrite 연결 금지

### Night B. 질문 세트 초안

목표:

- P1 계산형 RAG용 한국어/중국어 질문 세트를 만든다.
- 라우터 구현 전에 어떤 intent와 retriever가 필요한지 정리한다.

작업:

- `docs/rebuild/20-ai-p1-eval-questions.md` 작성
- 최소 30개 질문 작성
- 각 질문에 expected intent, required retriever, expected answer shape 작성

초기 intent:

- `production_summary`
- `machine_detail`
- `plan_gap`
- `production_output`

아직 제외:

- `risk_analysis`
- `document_rag`
- 자유 SQL

### Night C. Ask Pipeline 정리 초안

목표:

- `/api/production/ai/ask/`가 기존 local LLM 중심 흐름에서 계산형 retrieval 흐름으로 이동할 준비를 한다.

작업:

- 기존 `ai_gateway.py`와 새 P1 모듈의 중복/경계 검토
- 코드 변경은 최소화
- 필요하면 TODO 문서화
- 아직 `ai_router.py`를 크게 구현하지 않는다

## 퇴근 전 넣을 프롬프트

```text
AGENTS.md와 docs/codex-nightly-plan.md를 먼저 읽어줘.

Codex App Worktree 모드에서 진행해줘.

Branch name:
codex/nightly-ai-rag-p1

오늘 밤 목표는 Night A: P1 브리핑 v1 검증이야.

범위:
- backend/production/ai_types.py
- backend/production/ai_metrics.py
- backend/production/ai_retrievers.py
- backend/production/ai_context.py
- backend/production/ai_answer.py
- backend/production/views.py
- backend/production/urls.py
- frontend-next/src/domains/production/api.ts
- frontend-next/src/domains/production/pages/ProductionDashboardPage.tsx
- frontend-next/src/styles/global.css

해야 할 일:
- 현재 /api/production/ai/briefing/ 구현이 P1 MVP 경계와 맞는지 검토
- deterministic answer가 LLM 없이 작동하는지 확인
- schema/fallback/계산 기준에 명백한 오류가 있으면 작은 범위로 수정
- 가능한 smoke check 추가 또는 실행
- python py_compile 실행
- frontend를 수정했다면 npm run build 실행

금지:
- 문서 RAG, pgvector, Qdrant 구현 금지
- Mac Studio, 외부 LLM 연결 금지
- ai_router.py 대규모 구현 금지
- .env, credentials, deployment 설정 수정 금지
- migration 생성 금지
- main 직접 commit 금지
- push, PR 생성, 자동 merge 금지
- unrelated dirty file 수정 금지

끝나면 변경 파일, 실행한 명령, 완료 내용, 남은 위험, 다음 작업을 요약해줘.
```

## 아침 확인 체크리스트

- Codex summary 확인
- `git status --short` 확인
- `git diff` 확인
- 불필요한 범위 수정이 있는지 확인
- `python3 -m py_compile ...` 재실행
- `frontend-next` 변경이 있으면 `npm run build` 재실행
- `.env`, deployment, migration 변경이 없는지 확인
- 숫자 계산을 LLM에 맡기지 않았는지 확인

## 다음 단계 기준

Night A가 안정화되면 Night B로 넘어간다.

Night B 이후에야 `ai_router.py` 또는 `/api/production/ai/ask/` 계산형 pipeline 정리를 시작한다.
