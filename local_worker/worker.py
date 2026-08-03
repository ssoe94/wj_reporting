from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

try:
    from .job_handlers import production_daily_analysis, production_machine_analysis
    from .llm_client import LocalLlmClient
    from .render_client import RenderClient
except ImportError:
    from job_handlers import production_daily_analysis, production_machine_analysis
    from llm_client import LocalLlmClient
    from render_client import RenderClient


HANDLERS = {
    "production_daily_analysis": production_daily_analysis,
    "production_machine_analysis": production_machine_analysis,
}


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


NUMBER_TOKEN = re.compile(r"(?<![A-Za-z])\d+(?:[.,]\d+)?")


def summary_numbers_are_grounded(summary: str, grounding: dict[str, Any]) -> bool:
    allowed_text = json.dumps(grounding, ensure_ascii=False, default=str)
    allowed_tokens = set(NUMBER_TOKEN.findall(allowed_text))
    return set(NUMBER_TOKEN.findall(summary)).issubset(allowed_tokens)


def normalize_result(
    result: dict[str, Any],
    fallback: dict[str, Any],
    model_name: str,
    grounding: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Accept prose from the LLM while keeping every fact and issue deterministic."""
    candidate = dict(result or {})
    title = candidate.get("title")
    summary = candidate.get("summary")
    if not isinstance(title, str) or not title.strip():
        title = fallback.get("title") or "Local AI Analysis"
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("LLM response did not contain a summary string.")
    summary = summary.strip()[:2000]
    if not summary_numbers_are_grounded(f"{title} {summary}", grounding or fallback):
        raise ValueError("LLM prose introduced an unverified number.")

    normalized = dict(fallback)
    normalized.update({
        "title": title.strip()[:200],
        "summary": summary,
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "local_llm_rewrite",
    })
    return normalized


def handle_job(
    job: dict,
    use_llm: bool,
    llm: LocalLlmClient | None,
    model_name: str,
    fallback_to_deterministic: bool,
) -> tuple[dict, str]:
    job_type = job.get("job_type")
    handler = HANDLERS.get(job_type)
    if not handler:
        raise ValueError(f"Unsupported job type: {job_type}")

    deterministic = handler.build_dummy_result(job, model_name="deterministic-local-worker")
    if use_llm and llm:
        try:
            llm_payload = handler.build_llm_payload(job) if hasattr(handler, "build_llm_payload") else (job.get("input_payload") or {})
            result = llm.structured_analysis(handler.SYSTEM_PROMPT, {
                "job_type": job_type,
                "scope": job.get("scope") or {},
                "input_payload": llm_payload,
                "required_output_schema": {
                    "title": "string",
                    "summary": "string",
                },
            })
            return normalize_result(result, deterministic, model_name, llm_payload), handler.PROMPT_VERSION
        except Exception as exc:
            if not fallback_to_deterministic:
                raise
            deterministic["llm_fallback"] = True
            deterministic["llm_error"] = str(exc)[:500]
            deterministic["model_name"] = "deterministic-local-worker"
            deterministic["source"] = "deterministic_fallback"
            return deterministic, handler.PROMPT_VERSION

    deterministic["source"] = "deterministic"
    return deterministic, handler.PROMPT_VERSION


def run_once(
    client: RenderClient,
    worker_name: str,
    use_llm: bool,
    llm: LocalLlmClient | None,
    model_name: str,
    fallback_to_deterministic: bool,
    enqueue_periodic: bool,
) -> int:
    if enqueue_periodic:
        try:
            client.enqueue_periodic_jobs()
        except Exception as exc:
            print(f"failed to ensure periodic ai jobs: {exc}", file=sys.stderr)
    jobs = client.claim_jobs(worker_name, limit=1, job_types=list(HANDLERS.keys()))
    if not jobs:
        return 0

    for job in jobs:
        job_id = int(job["id"])
        try:
            client.start_job(job_id)
            result, prompt_version = handle_job(job, use_llm, llm, model_name, fallback_to_deterministic)
            client.complete_job(
                job_id,
                result_payload=result,
                model_name=result.get("model_name") or model_name,
                prompt_version=prompt_version,
            )
            print(f"completed ai job {job_id}")
        except Exception as exc:
            try:
                client.fail_job(job_id, str(exc), model_name=model_name)
            finally:
                print(f"failed ai job {job_id}: {exc}", file=sys.stderr)
    return len(jobs)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="claim and process at most one batch")
    parser.add_argument("--check-llm", action="store_true", help="verify the configured local LLM endpoint")
    args = parser.parse_args()

    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(env_path)

    api_base_url = os.getenv("RENDER_API_BASE_URL", "http://127.0.0.1:8000/api")
    worker_token = os.getenv("AI_WORKER_TOKEN", "")
    worker_name = os.getenv("WORKER_NAME", "mac-studio-local-ai")
    poll_interval = max(1, int(os.getenv("POLL_INTERVAL_SECONDS", "5") or 5))
    periodic_check_interval = max(60, int(os.getenv("PERIODIC_ENQUEUE_CHECK_SECONDS", "60") or 60))
    use_llm = truthy(os.getenv("AI_WORKER_USE_LLM"))
    fallback_to_deterministic = truthy(os.getenv("AI_WORKER_FALLBACK_TO_DETERMINISTIC", "true"))
    enqueue_periodic = truthy(os.getenv("AI_WORKER_ENQUEUE_PERIODIC", "true"))
    local_model = os.getenv(
        "LOCAL_LLM_MODEL",
        "/Users/macstudio_ted/Developer/local-ai/models/Qwen3.5-35B-A3B-4bit",
    )
    llm_timeout = max(5, int(os.getenv("LOCAL_LLM_TIMEOUT_SECONDS", "45") or 45))

    if not worker_token:
        print("AI_WORKER_TOKEN is required.", file=sys.stderr)
        return 2

    client = RenderClient(api_base_url=api_base_url, worker_token=worker_token)
    llm = None
    if use_llm:
        llm = LocalLlmClient(
            base_url=os.getenv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8080/v1"),
            model=local_model,
            timeout=llm_timeout,
        )

    if args.check_llm:
        if not llm:
            print("AI_WORKER_USE_LLM=true is required for --check-llm.", file=sys.stderr)
            return 2
        result = llm.structured_analysis(
            "Return only a JSON object with status and model_name.",
            {"task": "health_check", "expected_status": "ok"},
        )
        print(result)
        return 0

    next_periodic_check = 0.0
    while True:
        monotonic_now = time.monotonic()
        should_enqueue_periodic = enqueue_periodic and monotonic_now >= next_periodic_check
        try:
            run_once(
                client,
                worker_name,
                use_llm,
                llm,
                local_model,
                fallback_to_deterministic,
                should_enqueue_periodic,
            )
        except Exception as exc:
            print(f"worker polling failed: {exc}", file=sys.stderr)
            if args.once:
                return 1
        if should_enqueue_periodic:
            next_periodic_check = monotonic_now + periodic_check_interval
        if args.once:
            return 0
        time.sleep(poll_interval)


if __name__ == "__main__":
    raise SystemExit(main())
