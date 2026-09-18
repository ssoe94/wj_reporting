from __future__ import annotations

import json
import re
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlparse

import requests


# Upper bound for LOCAL_LLM_TIMEOUT_SECONDS. The backend re-pends a claimed job
# after AI_JOB_TIMEOUT_SECONDS (600 s), so a single generation must never
# outlive that lease.
MAX_LLM_TIMEOUT_SECONDS = 600
DEFAULT_LLM_TIMEOUT_SECONDS = 240
# Measured on the Mac Studio runtime: ~300 tok/s prefill (~1,200 latin chars/s)
# and ~35 tok/s decode. The estimate carries a fixed margin for queueing,
# HTTP overhead and CJK-heavy prompts whose char/token ratio is closer to 1.
PREFILL_TOKENS_PER_SECOND = 300.0
DECODE_TOKENS_PER_SECOND = 30.0
TIMEOUT_MARGIN_SECONDS = 30.0
IMAGE_PREFILL_SECONDS = 5.0
DEFAULT_MAX_TOKENS = 1200

_CJK_CHAR = re.compile(
    "["
    "ᄀ-ᇿ"  # Hangul Jamo
    "⺀-⿿"  # CJK radicals
    "　-〿"  # CJK punctuation
    "぀-ヿ"  # Hiragana / Katakana
    "㄰-㆏"  # Hangul compatibility Jamo
    "ㇰ-ㇿ"
    "㐀-䶿"  # CJK extension A
    "一-鿿"  # CJK unified ideographs
    "ꥠ-꥿"
    "가-퟿"  # Hangul syllables
    "豈-﫿"  # CJK compatibility ideographs
    "＀-￯"  # Fullwidth forms
    "]"
)


def estimate_prompt_tokens(text: str) -> int:
    """Cheap token estimate: latin chars / 4 plus one token per CJK char."""
    value = str(text or "")
    cjk_count = len(_CJK_CHAR.findall(value))
    latin_count = len(value) - cjk_count
    return int(latin_count / 4) + cjk_count


def estimate_call_timeout_seconds(
    prompt_tokens: int,
    max_tokens: int,
    *,
    image_count: int = 0,
) -> float:
    """Return ``prompt_tokens / 300 + max_tokens / 30 + 30`` (plus 5 s per image).

    ``prompt_tokens`` comes from :func:`estimate_prompt_tokens`; counting
    characters would under-estimate Korean/Chinese prompts about four-fold.
    """
    return (
        max(0, int(prompt_tokens)) / PREFILL_TOKENS_PER_SECOND
        + max(0, int(max_tokens)) / DECODE_TOKENS_PER_SECOND
        + TIMEOUT_MARGIN_SECONDS
        + max(0, int(image_count)) * IMAGE_PREFILL_SECONDS
    )


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
        self.timeout = max(1, min(MAX_LLM_TIMEOUT_SECONDS, int(timeout)))
        self.model_family = model_family

    @property
    def model_display_name(self) -> str:
        """Checkpoint basename reported to the backend instead of the local path."""
        return self.model.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]

    def call_timeout_seconds(
        self,
        prompt_tokens: int,
        max_tokens: int,
        *,
        requested_seconds: float | None = None,
        image_count: int = 0,
    ) -> float:
        """Per-call HTTP timeout: ``min(configured, estimate)``.

        ``prompt_tokens`` is the :func:`estimate_prompt_tokens` value of the
        full prompt. A handler may pass ``requested_seconds`` as a floor for
        calls whose cost is not captured by prompt size (for example strict
        JSON-schema selections); the configured ceiling still bounds the result.
        """
        estimate = estimate_call_timeout_seconds(
            prompt_tokens,
            max_tokens,
            image_count=image_count,
        )
        if requested_seconds is not None:
            estimate = max(estimate, max(1.0, float(requested_seconds)))
        return min(float(self.timeout), estimate)

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
            "max_tokens": DEFAULT_MAX_TOKENS,
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
        image_count = len(user_content) - 1 if isinstance(user_content, list) else 0
        response = requests.post(
            f"{self.base_url}/chat/completions",
            json=request_payload,
            timeout=self.call_timeout_seconds(
                estimate_prompt_tokens(system_prompt) + estimate_prompt_tokens(user_text),
                request_payload["max_tokens"],
                requested_seconds=timeout_seconds,
                image_count=image_count,
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
