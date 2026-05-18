from __future__ import annotations

import requests


class RenderClient:
    def __init__(self, api_base_url: str, worker_token: str, timeout: int = 30):
        self.api_base_url = api_base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/json",
            "X-AI-WORKER-TOKEN": worker_token,
        })

    def claim_jobs(self, worker_name: str, limit: int = 1, job_types: list[str] | None = None) -> list[dict]:
        payload: dict = {"worker_name": worker_name, "limit": limit}
        if job_types:
            payload["job_types"] = job_types
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/claim/",
            json=payload,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json().get("jobs", [])

    def start_job(self, job_id: int) -> dict:
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/{job_id}/start/",
            json={},
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
    ) -> dict:
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/{job_id}/complete/",
            json={
                "result_payload": result_payload,
                "model_name": model_name,
                "prompt_version": prompt_version,
            },
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
    ) -> dict:
        response = self.session.post(
            f"{self.api_base_url}/ai/jobs/{job_id}/fail/",
            json={
                "error_message": error_message[:4000],
                "model_name": model_name,
                "prompt_version": prompt_version,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()
