from __future__ import annotations

import json
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlparse

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
    def __init__(
        self,
        base_url: str,
        model: str,
        timeout: int = 120,
        model_family: str = "qwen",
    ):
        normalized_base_url = base_url.rstrip("/")
        parsed = urlparse(normalized_base_url)
        hostname = str(parsed.hostname or "").lower()
        try:
            is_loopback = ip_address(hostname).is_loopback
        except ValueError:
            is_loopback = hostname == "localhost"
        if (
            parsed.scheme not in {"http", "https"}
            or not is_loopback
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise ValueError("Local LLM base_url must use a loopback HTTP(S) address.")
        self.base_url = normalized_base_url
        self.model = model
        self.timeout = timeout
        self.model_family = model_family

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
        max_tokens: int | None = None,
        json_object: bool = False,
        json_schema: dict[str, Any] | None = None,
        image_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        user_text = json.dumps(user_payload, ensure_ascii=False, default=str)
        user_content: str | list[dict[str, Any]] = user_text
        if image_urls:
            user_content = [
                {
                    "type": "image_url",
                    "image_url": {"url": str(image_url)},
                }
                for image_url in image_urls
                if str(image_url or "").strip()
            ]
            user_content.append({"type": "text", "text": user_text})
        request_payload: dict[str, Any] = {
            "model": self.model,
            "temperature": 0.1,
            "max_tokens": 1200,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": user_content,
                },
            ],
        }
        if self.model_family == "qwen":
            request_payload["enable_thinking"] = enable_thinking
            if enable_thinking and thinking_budget is not None:
                request_payload["thinking_budget"] = max(1, int(thinking_budget))
        elif self.model_family == "gemma4":
            # Gemma's unbounded thinking mode can consume the whole completion
            # budget before emitting the required JSON. The Worker needs a
            # short auditable answer, so keep thinking disabled for both the
            # first pass and repair pass.
            request_payload.update({
                "temperature": 0.2,
                "top_k": 64,
                "top_p": 0.95,
                "max_tokens": 1800,
            })
            request_payload["chat_template_kwargs"] = {
                "enable_thinking": False,
            }
        if max_tokens is not None:
            request_payload["max_tokens"] = max(128, min(4096, int(max_tokens)))
        if json_schema is not None:
            if json_object:
                raise ValueError("json_object and json_schema are mutually exclusive.")
            if not isinstance(json_schema, dict) or not json_schema:
                raise ValueError("json_schema must be a non-empty object.")
            request_payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "bounded_analysis",
                    "strict": True,
                    "schema": json_schema,
                },
            }
        elif json_object:
            # The OpenAI-compatible MLX server supports JSON-object mode.
            # Opt in per bounded handler so other local-model workflows keep
            # their existing request contract.
            request_payload["response_format"] = {"type": "json_object"}
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
