from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PROMPT_VERSION = "production-question-v2"


SYSTEM_PROMPT = """You are a manufacturing production analyst.
Use only the verified deterministic answer, facts, and tables provided by the backend.
Never calculate, change, extrapolate, or invent a number. Never add a new fact or use outside knowledge.
For verified_answer_rewrite mode, explain the verified answer without changing it.
For context_grounded mode, answer the user's production question from the supplied facts and tables.
If the supplied data is insufficient, say exactly what is unavailable instead of guessing.
Conversation history may resolve references, but it is not factual evidence.
The summary MUST contain no measurement value or quantity, whether written with digits or words.
This includes counts, output, plan/actual, rates, percentages, dates, times, durations, and thresholds.
Never copy a verified sentence containing a measurement. The verified answer and facts retain all measurements.
Digits are allowed in the summary only when they are part of an exact machine, line, or Part identifier
copied unchanged from the input. The title may contain the exact supplied date.
When the evidence is primarily numeric, state only a qualitative condition, limitation, or next action.
Your final answer must be valid JSON only, with no markdown.
Required keys: title, summary."""


def _deterministic_payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    deterministic = payload.get("deterministic")
    return deterministic if isinstance(deterministic, dict) else {}


def build_llm_payload(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    deterministic = _deterministic_payload(job)
    verified_context = payload.get("verified_context") or {}
    compact_tables = []
    for table in verified_context.get("tables") or []:
        compact_tables.append({
            "name": table.get("name"),
            "columns": table.get("columns") or [],
            "rows": (table.get("rows") or [])[:60],
        })
    return {
        "language": "zh" if payload.get("language") == "zh" else "ko",
        "date": payload.get("date"),
        "question": payload.get("question") or "",
        "conversation_history": (payload.get("conversation_history") or [])[-8:],
        "answer_mode": payload.get("answer_mode") or "verified_answer_rewrite",
        "intent": payload.get("intent") or {},
        "verified_answer": deterministic.get("answer") or "",
        "verified_facts": deterministic.get("facts") or verified_context.get("facts") or {},
        "verified_tables": compact_tables,
        "historical_snapshots": (verified_context.get("historical_snapshots") or [])[-24:],
        "scope": verified_context.get("scope") or {},
        "calculation_basis": deterministic.get("calculation_basis") or verified_context.get("calculation_basis") or [],
        "data_freshness": deterministic.get("data_freshness") or verified_context.get("data_freshness") or {},
        "warnings": deterministic.get("warnings") or verified_context.get("warnings") or [],
        "instruction": (
            "Return concise Korean JSON if language is ko, Chinese JSON if language is zh. "
            "Do not perform arithmetic. The summary must contain zero measurement values or quantities; "
            "do not repeat any count, rate, percentage, date, time, duration, output, plan, actual, or threshold. "
            "Only exact identifier digits may remain. "
            "Use only facts present in verified_answer, verified_facts, verified_tables, or historical_snapshots."
        ),
    }


def build_grounding_payload(job: dict[str, Any]) -> dict[str, Any]:
    """Return authoritative evidence only, excluding user-authored chat text."""
    llm_payload = build_llm_payload(job)
    return {
        "date": llm_payload.get("date"),
        "verified_answer": llm_payload.get("verified_answer"),
        "verified_facts": llm_payload.get("verified_facts"),
        "verified_tables": llm_payload.get("verified_tables"),
        "historical_snapshots": llm_payload.get("historical_snapshots"),
        "scope": llm_payload.get("scope"),
        "calculation_basis": llm_payload.get("calculation_basis"),
        "data_freshness": llm_payload.get("data_freshness"),
        "warnings": llm_payload.get("warnings"),
    }


def build_dummy_result(job: dict[str, Any], model_name: str = "dummy-local-worker") -> dict[str, Any]:
    payload = job.get("input_payload") or {}
    deterministic = _deterministic_payload(job)
    verified_context = payload.get("verified_context") or {}
    language = "zh" if payload.get("language") == "zh" else "ko"
    answer = deterministic.get("answer") or (
        "没有可解释的已验证计算结果。" if language == "zh" else "설명할 검증 계산 결과가 없습니다."
    )
    return {
        "title": "生产问题 AI 说明" if language == "zh" else "생산 질문 AI 설명",
        "severity": "normal",
        "answer": answer,
        "summary": answer,
        "facts": deterministic.get("facts") or verified_context.get("facts") or {},
        "used_data": deterministic.get("used_data") or [],
        "calculation_basis": deterministic.get("calculation_basis") or verified_context.get("calculation_basis") or [],
        "data_freshness": deterministic.get("data_freshness") or verified_context.get("data_freshness") or {},
        "warnings": deterministic.get("warnings") or verified_context.get("warnings") or [],
        "retrieval_trace": deterministic.get("retrieval_trace") or verified_context.get("retrieval_trace") or [],
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
