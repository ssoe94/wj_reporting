# Local AI Worker

This worker runs on the Mac Studio and calls the Render backend using outbound HTTP only.

## Local test

```bash
cd local_worker
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python worker.py --once
```

`AI_WORKER_USE_LLM=false` keeps the worker in dummy-analysis mode. Set it to `true` only when an OpenAI-compatible local LLM endpoint is running at `LOCAL_LLM_BASE_URL`.

## LLM mode

Start a local OpenAI-compatible MLX server first:

```bash
cd ..
./scripts/start-local-mlx-llm.sh
```

Then verify the endpoint:

```bash
cd local_worker
AI_WORKER_USE_LLM=true AI_WORKER_TOKEN=change-me python worker.py --check-llm
```

`AI_WORKER_FALLBACK_TO_DETERMINISTIC=true` lets the worker complete a job with deterministic analysis if the local LLM fails or returns invalid JSON. Set it to `false` when testing strict LLM failures.

```env
RENDER_API_BASE_URL=http://127.0.0.1:8000/api
AI_WORKER_TOKEN=change-me
LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_LLM_MODEL=qwen3:8b
LOCAL_VLM_MODEL=qwen3-vl:8b
LOCAL_LLM_TIMEOUT_SECONDS=45
WORKER_NAME=mac-studio-local-ai
POLL_INTERVAL_SECONDS=5
AI_WORKER_USE_LLM=false
AI_WORKER_FALLBACK_TO_DETERMINISTIC=true
```
