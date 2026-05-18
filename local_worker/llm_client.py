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

    def structured_analysis(self, system_prompt: str, user_payload: dict[str, Any]) -> dict[str, Any]:
        response = requests.post(
            f"{self.base_url}/chat/completions",
            json={
                "model": self.model,
                "temperature": 0.1,
                "max_tokens": 1200,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps(user_payload, ensure_ascii=False, default=str),
                    },
                ],
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = response.json()
        message = data.get("choices", [{}])[0].get("message", {})
        content = message.get("content") or message.get("reasoning") or ""
        return extract_json_object(content)
