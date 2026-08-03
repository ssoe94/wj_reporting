from __future__ import annotations

import json
from typing import Any

import requests


def extract_json_object(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text.strip())
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(text[start:end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("LLM response did not contain a JSON object.")


class LocalLlmClient:
    def __init__(self, base_url: str, model: str, timeout: int = 120):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def is_ready(self, timeout: int = 3) -> bool:
        try:
            response = requests.get(f"{self.base_url}/models", timeout=timeout)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                return False
            configured = self.model.replace("\\", "/").rstrip("/")
            configured_basename = configured.rsplit("/", 1)[-1]
            for item in payload["data"]:
                model_id = item.get("id") if isinstance(item, dict) else item if isinstance(item, str) else ""
                normalized = str(model_id or "").replace("\\", "/").rstrip("/")
                if not normalized:
                    continue
                if normalized == configured or normalized.rsplit("/", 1)[-1] == configured_basename:
                    return True
            return False
        except (requests.RequestException, ValueError):
            return False

    def structured_analysis(
        self,
        system_prompt: str,
        user_payload: dict[str, Any],
        *,
        enable_thinking: bool = False,
        thinking_budget: int | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        request_payload: dict[str, Any] = {
            "model": self.model,
            "temperature": 0.1,
            "max_tokens": 1200,
            "enable_thinking": enable_thinking,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps(user_payload, ensure_ascii=False, default=str),
                },
            ],
        }
        if enable_thinking and thinking_budget is not None:
            request_payload["thinking_budget"] = max(1, int(thinking_budget))
        response = requests.post(
            f"{self.base_url}/chat/completions",
            json=request_payload,
            timeout=(
                self.timeout
                if timeout_seconds is None
                else min(self.timeout, max(1.0, float(timeout_seconds)))
            ),
        )
        response.raise_for_status()
        data = response.json()
        choice = data.get("choices", [{}])[0]
        if choice.get("finish_reason") in {"length", "max_tokens"}:
            raise ValueError("LLM response ended before the final answer was completed.")
        message = choice.get("message", {})
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("LLM response did not contain final answer content.")
        return extract_json_object(content)
