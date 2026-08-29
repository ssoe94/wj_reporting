from __future__ import annotations

import requests


WORKER_VERSION = "production-ai-worker-v2"


class RenderClient:
    def __init__(self, api_base_url: str, worker_token: str, timeout: int = 30):
        self.api_base_url = api_base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "X-AI-WORKER-TOKEN": worker_token,
        })

    def claim_jobs(
        self,
        worker_name: str,
        limit: int = 1,
        job_types: list[str] | None = None,
        worker_version: str = WORKER_VERSION,
        available_model_ids: list[str] | None = None,
    ) -> list[dict]:
        payload: dict = {
            "worker_name": worker_name,
            "worker_version": worker_version,
            "limit": limit,
            "available_model_ids": available_model_ids or [],
        }
        if job_types:
            payload["job_types"] = job_types
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/claim/",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json().get("jobs", [])

    def enqueue_periodic_jobs(self, languages: list[str] | None = None) -> dict:
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/enqueue-periodic/",
            json={"languages": languages or ["ko", "zh"]},
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def send_heartbeat(
        self,
        worker_name: str,
        *,
        llm_enabled: bool,
        llm_ready: bool | None,
        model_name: str = "",
        worker_version: str = "",
        last_error: str = "",
        available_model_ids: list[str] | None = None,
    ) -> dict:
        response = self.session.post(
            f"{self.api_base_url}/ai/worker/heartbeat/",
            json={
                "worker_name": worker_name,
                "llm_enabled": llm_enabled,
                "llm_ready": llm_ready,
                "model_name": model_name,
                "worker_version": worker_version,
                "last_error": last_error[:500],
                "available_model_ids": available_model_ids or [],
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def start_job(
        self,
        job_id: int,
        *,
        worker_name: str = "",
        claim_timestamp: str = "",
    ) -> dict:
        payload: dict = {}
        if worker_name:
            payload["worker_name"] = worker_name
        if claim_timestamp:
            payload["claim_timestamp"] = claim_timestamp
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/{job_id}/start/",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def complete_job(
        self,
        job_id: int,
        result_payload: dict,
        model_name: str = "",
        prompt_version: str = "",
        worker_name: str = "",
        claim_timestamp: str = "",
    ) -> dict:
        payload = {"result_payload": result_payload}
        if model_name:
            payload["model_name"] = model_name
        if prompt_version:
            payload["prompt_version"] = prompt_version
        if worker_name:
            payload["worker_name"] = worker_name
        if claim_timestamp:
            payload["claim_timestamp"] = claim_timestamp
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/{job_id}/complete/",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def fail_job(
        self,
        job_id: int,
        error_message: str,
        model_name: str = "",
        prompt_version: str = "",
        worker_name: str = "",
        claim_timestamp: str = "",
    ) -> dict:
        payload = {"error_message": error_message[:4000]}
        if model_name:
            payload["model_name"] = model_name
        if prompt_version:
            payload["prompt_version"] = prompt_version
        if worker_name:
            payload["worker_name"] = worker_name
        if claim_timestamp:
            payload["claim_timestamp"] = claim_timestamp
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/{job_id}/fail/",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()
