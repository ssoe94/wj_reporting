# Render + Mac Studio 로컬 AI Worker 계획

## 1. 목적

WJ Reporting의 운영 사이트는 계속 Render에 둔다. 프런트엔드, Django 백엔드, PostgreSQL은 Render에서 운영하고, Mac Studio는 로컬 AI 연산 Worker로만 사용한다.

이 문서는 Render에서 운영 중인 사이트가 Mac Studio의 로컬 LLM을 직접 호출할 수 없는 문제를 해결하기 위한 비동기 AI 작업 구조를 정의한다.

1단계 산출물은 이 문서 하나다. 백엔드 모델, API, 프런트엔드 UI, Worker 스크립트는 이 문서를 검토한 뒤 별도 단계에서 구현한다.

## 2. 현재 구조

현재 운영 방향은 다음과 같다.

- Render Frontend가 운영 웹사이트를 제공한다.
- Render Django Backend가 API를 제공한다.
- Render PostgreSQL이 운영 데이터를 저장한다.
- 기존 production AI 코드는 `backend/production/` 아래에 있다.

기존 production AI 파일:

- `backend/production/ai_gateway.py`
- `backend/production/ai_answer.py`
- `backend/production/ai_context.py`
- `backend/production/ai_retrievers.py`
- `backend/production/ai_types.py`

기존 production AI API:

- `/api/production/ai/briefing/`
- `/api/production/ai/ask/`

현재 문제:

- `ai_gateway.py`는 `LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1` 같은 로컬 LLM 주소를 전제로 한다.
- Django가 Render에서 실행될 때 `127.0.0.1`은 Mac Studio가 아니라 Render 컨테이너 자신을 의미한다.
- 따라서 Render 백엔드는 Mac Studio에서 실행 중인 로컬 LLM을 직접 호출할 수 없다.

## 3. 목표 구조

```text
Render Frontend
  ↓
Render Django Backend
  ↓
AiJob table
  ↑
Mac Studio AI Worker
  ↓
Local LLM / VLM
```

Render는 계속 메인 운영 사이트로 사용한다. Mac Studio는 AI 연산만 담당한다. 사용자가 Render 사이트에서 AI 분석을 요청하면 Django 백엔드가 `AiJob`을 만들고, Mac Studio Worker가 Render API를 주기적으로 호출해 작업을 가져간다.

Worker는 작업을 claim한 뒤 로컬 LLM을 호출하고, 결과를 다시 Render API로 제출한다. 사용자는 Render 사이트에서 작업 상태와 결과를 확인한다.

MVP는 텍스트 기반 LLM 분석부터 시작한다. 이미지 기반 VLM 분석은 후속 확장으로만 남긴다.

## 4. 이 구조를 선택하는 이유

이 구조는 Mac Studio를 외부에 직접 노출하는 방식보다 안전하고 단순하다.

- Render 배포 구조를 유지할 수 있다.
- 메인 사이트를 내부망으로 옮길 필요가 없다.
- Mac Studio는 외부 inbound 접속을 받을 필요가 없다.
- public IP, tunnel, FRP, Cloudflare Tunnel, ngrok, 사내망 통합이 MVP에 필요하지 않다.
- Ollama, llama.cpp, MLX, 로컬 VLM 포트를 인터넷에 노출하지 않는다.
- Mac Studio Worker가 Render에 outbound 접속만 할 수 있으면 AI 작업을 처리할 수 있다.
- Mac Studio가 꺼져 있어도 메인 사이트는 계속 동작하고 AI 작업만 pending 상태로 남는다.

## 5. MVP 범위

MVP에 포함할 것:

- 새 Django app `ai_core`
- `AiJob` 모델
- `AiJob.result_payload` 기반 결과 저장
- 사용자용 job 생성, 목록, 상세, 취소 API
- Worker 전용 claim, start, complete, fail API
- `X-AI-WORKER-TOKEN` 기반 Worker 인증
- Mac Studio에서 실행할 polling Worker 스크립트
- 텍스트 기반 `production_daily_analysis`
- 텍스트 기반 `production_machine_analysis`
- 프런트엔드 AI 분석 요청 및 결과 확인 UI

MVP에서 제외할 것:

- 메신저 연동
- 채팅 기반 이슈 수집
- inbound message callback
- outbound group notification
- 이미지 기반 VLM 분석 구현
- 로컬 AI 포트의 외부 공개
- 운영 환경에서 브라우저가 Mac Studio 로컬 LLM을 직접 호출하는 구조

## 6. AiJob 모델 초안

MVP에서는 하나의 `AiJob` 모델만 사용한다. 작업당 하나의 구조화 결과면 충분하므로 별도 `AiResult` 모델은 만들지 않는다. 나중에 결과 버전 관리, 여러 artifact 저장, 평가 로그가 필요해지면 `AiResult`를 분리한다.

```python
class AiJob(models.Model):
    JOB_TYPE_CHOICES = [
        ("production_daily_analysis", "Production Daily Analysis"),
        ("production_machine_analysis", "Production Machine Analysis"),
        ("quality_image_analysis", "Quality Image Analysis"),
    ]

    STATUS_CHOICES = [
        ("pending", "Pending"),
        ("claimed", "Claimed"),
        ("running", "Running"),
        ("completed", "Completed"),
        ("failed", "Failed"),
        ("cancelled", "Cancelled"),
    ]

    job_type = models.CharField(max_length=64, choices=JOB_TYPE_CHOICES)
    status = models.CharField(max_length=32, choices=STATUS_CHOICES, default="pending")
    scope = models.JSONField(default=dict, blank=True)
    input_payload = models.JSONField(default=dict, blank=True)
    result_payload = models.JSONField(default=dict, blank=True)
    error_message = models.TextField(blank=True, default="")
    claimed_by = models.CharField(max_length=128, blank=True, default="")
    claimed_at = models.DateTimeField(null=True, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    model_name = models.CharField(max_length=128, blank=True, default="")
    prompt_version = models.CharField(max_length=64, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

Job type 적용 순서:

- `production_daily_analysis`: 첫 구현 대상
- `production_machine_analysis`: daily analysis 이후 구현
- `quality_image_analysis`: 후속 확장용 placeholder

Worker는 사전에 정의된 job type만 처리한다. job payload에 포함된 임의 코드나 동적 명령을 실행하면 안 된다.

## 7. API 초안

최종 URL 구조는 구현 시 현재 Django URL 구조에 맞춰 조정할 수 있다. 기본 방향은 다음과 같다.

사용자용 API:

- `POST /api/ai/jobs/`
- `GET /api/ai/jobs/`
- `GET /api/ai/jobs/{id}/`
- `POST /api/ai/jobs/{id}/cancel/`

Worker 전용 API:

- `POST /api/ai/jobs/claim/`
- `POST /api/ai/jobs/{id}/start/`
- `POST /api/ai/jobs/{id}/complete/`
- `POST /api/ai/jobs/{id}/fail/`

Worker 전용 API는 반드시 다음 header를 요구한다.

```http
X-AI-WORKER-TOKEN: <secret>
```

Claim 규칙:

- claim은 원자적으로 처리한다.
- 가능한 경우 database transaction과 row-level lock을 사용한다.
- 기본 claim limit은 1이다.
- pending 작업 중 오래된 순서로 claim한다.
- timeout을 넘긴 `claimed`, `running` 작업은 재시도 가능하게 설계한다.
- cancelled 작업은 claim하지 않는다.

## 8. Worker 폴더 초안

```text
local_worker/
  README.md
  requirements.txt
  .env.example
  worker.py
  llm_client.py
  render_client.py
  job_handlers/
    production_daily_analysis.py
    production_machine_analysis.py
```

Worker 책임:

- Render API polling
- pending job claim
- job started 상태 전환
- 필요한 production context 조회
- 로컬 LLM 호출
- structured JSON 결과 검증
- 성공 시 `result_payload` 제출
- 실패 시 `error_message`와 함께 fail 처리

Worker는 처음부터 실제 LLM을 붙이지 않고 dummy analysis handler로 시작한다. 이렇게 하면 API, 인증, job lifecycle을 먼저 안정적으로 검증할 수 있다.

## 9. 환경 변수

Backend `.env.example` 추가 항목:

```env
AI_WORKER_TOKEN=change-me
AI_JOB_CLAIM_LIMIT=1
AI_JOB_TIMEOUT_SECONDS=600
```

Worker `.env.example`:

```env
RENDER_API_BASE_URL=https://wj-reporting-backend.onrender.com/api
AI_WORKER_TOKEN=change-me
LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_LLM_MODEL=qwen3:8b
LOCAL_VLM_MODEL=qwen3-vl:8b
WORKER_NAME=mac-studio-local-ai
POLL_INTERVAL_SECONDS=5
```

`LOCAL_VLM_MODEL`은 후속 확장 가능성을 위해서만 남긴다. MVP 구현에서는 이미지 분석을 실행하지 않는다.

## 10. AI 출력 형식

AI 결과는 가능한 한 structured JSON으로 저장한다.

예시 production analysis 결과:

```json
{
  "title": "Daily Production AI Analysis",
  "severity": "warning",
  "summary": "Injection progress is behind the time baseline.",
  "top_issues": [
    {
      "type": "machine_delay",
      "severity": "high",
      "label": "850T-2",
      "evidence": [
        "Actual quantity is below planned quantity",
        "Recent 60-minute shot count is low"
      ],
      "possible_causes": [
        "Cycle time delay",
        "Machine stop",
        "Plan/MES mismatch"
      ],
      "recommended_actions": [
        "Check machine status",
        "Confirm latest MES data",
        "Review current part quality history"
      ]
    }
  ],
  "used_data": [],
  "calculation_basis": [],
  "model_name": "local-model-name",
  "generated_at": "ISO datetime"
}
```

백엔드는 원본 structured result를 `result_payload`에 저장한다. 프런트엔드는 이 결과를 카드, 이슈 리스트, 계산 근거 섹션으로 표현할 수 있다.

## 11. 프런트엔드 MVP

프런트엔드는 기존 production AI endpoint를 깨지 않으면서 신규 async job UI를 추가한다.

기대 동작:

- 사용자가 생산 대시보드 또는 AI 분석 패널을 연다.
- 사용자가 AI 분석 버튼을 클릭한다.
- 프런트엔드가 `AiJob`을 생성한다.
- 프런트엔드가 job status를 polling한다.
- UI가 `pending`, `claimed`, `running`, `completed`, `failed`, `cancelled` 상태를 표시한다.
- 완료된 job은 structured result를 표시한다.
- 실패한 job은 사용자가 이해할 수 있는 오류 상태를 표시한다.

기존 endpoint는 유지한다.

- `/api/production/ai/briefing/`
- `/api/production/ai/ask/`

신규 비동기 Worker 흐름은 `/api/ai/jobs/`를 사용한다. 기존 direct local LLM 경로는 local development fallback으로만 취급하고, Render 운영 환경의 필수 경로가 되지 않게 한다.

## 12. 보안 요구사항

- Mac Studio를 public IP로 노출하지 않는다.
- MVP에서 tunnel을 사용하지 않는다.
- Ollama, llama.cpp, MLX, 로컬 VLM 포트를 외부에 공개하지 않는다.
- `AI_WORKER_TOKEN`은 백엔드와 Worker 환경 변수에만 둔다.
- Worker token을 프런트엔드에 노출하지 않는다.
- 임의 SQL을 허용하지 않는다.
- LLM이 production data를 직접 수정하게 하지 않는다.
- Worker가 job payload의 임의 코드를 실행하지 않게 한다.
- 사전에 정의된 job type만 허용한다.
- model name, prompt version, input summary, result, timestamps, errors를 감사 목적으로 저장한다.
- 사용자용 API는 기존 인증 체계로 보호한다.
- Worker 전용 API는 사용자용 API와 명확히 분리한다.

## 13. 구현 단계

### Phase 1. 계획서 작성

생성 또는 업데이트:

- `docs/LOCAL_AI_WORKER_PLAN.md`

이 단계 이후 멈춘다.

### Phase 2. Backend ai_core app

- Django app `ai_core` 생성
- `AiJob` 모델 추가
- serializer 추가
- permission 추가
- Worker token 인증 추가
- views, urls 추가
- admin 추가
- migration 추가
- `.env.example` 변수 추가
- settings에 app 등록
- 기존 production AI endpoint는 깨지지 않게 유지

### Phase 3. Mac Studio local Worker

- `local_worker/` 추가
- Render polling 구현
- job claim 구현
- dummy analysis 먼저 실행
- complete/fail 처리
- README와 `.env.example` 추가

### Phase 4. Production analysis job

- 가능한 범위에서 기존 `production.ai_retrievers` 재사용
- structured production context 생성
- Worker가 로컬 LLM 호출
- structured result를 `AiJob.result_payload`에 저장

### Phase 5. Frontend AI job UI

- AI 분석 패널 또는 페이지 추가
- job 생성
- job status polling
- structured result 표시
- 생산 대시보드에서 접근 경로 추가

### Phase 6. 향후 multimodal 확장

- 텍스트 분석이 안정화된 뒤 image-capable job type 추가
- Worker가 인증된 이미지 URL 또는 승인된 다운로드 경로 사용
- 로컬 VLM으로 이미지 분석
- 시각적 관찰 결과와 의심 유형 저장
- 최종 판단은 human review 유지

## 14. 테스트 계획

Backend 테스트:

- 인증된 사용자가 AI job을 생성, 조회, 취소할 수 있다.
- 인증되지 않은 사용자는 AI job을 생성하거나 조회할 수 없다.
- Worker token 없이는 claim/start/complete/fail API에 접근할 수 없다.
- 잘못된 Worker token은 거부된다.
- claim은 pending job만 선택한다.
- 동시에 두 Worker가 같은 job을 claim하지 못한다.
- timeout을 넘긴 claimed/running job은 재시도 가능하다.
- completed/cancelled job은 다시 claim되지 않는다.

Worker 테스트:

- Worker가 dummy job을 claim할 수 있다.
- Worker가 job을 started로 전환할 수 있다.
- Worker가 유효한 JSON 결과로 job을 complete할 수 있다.
- Worker가 잘못된 JSON 결과를 error와 함께 fail 처리할 수 있다.
- 로컬 LLM 연결 실패 시 Worker가 중단되지 않고 job을 fail 처리한다.

Frontend 테스트:

- 사용자가 AI 분석을 요청할 수 있다.
- pending/running/completed/failed 상태가 정상 표시된다.
- completed structured result가 읽기 쉬운 형태로 표시된다.
- failed job이 대시보드를 깨뜨리지 않고 오류 상태로 표시된다.

운영 검증:

- Mac Studio가 꺼져 있어도 Render 사이트는 정상 동작한다.
- Worker가 꺼져 있으면 AI job은 pending 상태로 남는다.
- Worker가 다시 켜지면 pending job을 처리한다.
- 운영 경로에서 Render가 로컬 AI 호출을 위해 `127.0.0.1`에 의존하지 않는다.
