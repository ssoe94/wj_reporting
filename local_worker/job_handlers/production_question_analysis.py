from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

try:
    from ..skills.production_analyst import build_skill_payload, insert_verified_metrics, prioritize_verified_rows
except ImportError:
    from skills.production_analyst import build_skill_payload, insert_verified_metrics, prioritize_verified_rows


PROMPT_VERSION = "production-question-v7"
ENABLE_THINKING = True
THINKING_BUDGET = 384
INITIAL_TIMEOUT_SECONDS = 100
REPAIR_TIMEOUT_SECONDS = 45


SYSTEM_PROMPT = """You are a manufacturing production analyst.
Use only the verified deterministic answer, facts, and tables provided by the backend.
Never calculate, change, extrapolate, or invent a number. Never add a new fact or use outside knowledge.
For verified_answer_rewrite mode, copy the complete verified_answer verbatim at the start of the conclusion,
then explain it without changing it. That verbatim text is the only place measurements or quantities may appear.
For context_grounded mode, answer the user's production question from the supplied facts and tables.
If the supplied data is insufficient, say exactly what is unavailable instead of guessing.
For a yes/no or current-status question, answer directly in the first sentence from the verified status field.
Treat in_progress as currently in production, pending as not started, and completed as completed.
Do not claim that status is unavailable when a matching verified row contains one of these values.
Treat is_running=true as currently running. Never recommend restarting or resuming that equipment.
Treat is_running=false only as not running at the verified snapshot; do not call it a fault without cause data.
For injection_active_machine_count, "active" means the MES counter increased at least once inside the verified
window. Do not describe those machines as currently running unless a separate verified is_running=true fact exists.
If active_machine_count is null or the warnings say capacity data is missing, preserve the verified unavailable
answer. Never restate missing data as no active machines, zero machines, or an empty active set.
Translate status codes into natural Korean or Chinese instead of exposing raw codes such as on_track or true.
Never expose backend schema names such as shot_count, active_machine_count, or lookback_minutes; use natural language.
The summary must not contain these raw tokens: on_track, behind, ahead, no_plan, in_progress,
pending, completed, is_running, true, false.
Conversation history may resolve references, but it is not factual evidence.
analysis_skill limitations and answer_constraints are mandatory, not suggestions.
If historical_snapshots_unavailable or target_level_history_unavailable is present, state directly that
the requested target trend cannot be determined from the available history. Describe only the current snapshot.
Never turn one current completion rate or an in_progress status into a trend, delay, improvement, or worsening claim.
Do not call a current target 미달, 낮은 수준, 부족, or delayed merely because actual is below the full-day plan.
For missing target history, ask to collect or retrieve target-level time snapshots; do not ask to reconfirm a metric
already present in verified_evidence_sentences.
Do not ask to reconfirm a verified current production or running status. Ask only for missing history, cause, or plan data.
When analysis_skill.focus_identifiers is non-empty, discuss only rows sharing those identifiers.
Do not cite an unrelated machine, line, Part, or model merely because it appears in the supplied tables.
Reason internally, but never reveal private chain-of-thought. Show only an auditable evidence summary.
The summary must use this exact section order for Korean:
결론: one direct answer

판단 근거:
- two or three concrete evidence bullets when available

확인할 항목:
- one or two concrete checks, limitations, or next actions
For Chinese, use the same structure with 结论, 判断依据, and 需确认.
Separate every section with a blank line and do not collapse the headings into one paragraph.
Prefer exact verified process, machine, line, Part, and model identifiers over vague phrases.
Do not say 일부, 대부분, 일부 설비, or similar vague quantifiers. When equipment rows are relevant,
name the exact supplied equipment identifiers and describe each verified state separately.
Do not infer a cause, priority, count, or majority from rows. Limit evidence to the three most relevant supplied facts.
Use analysis_skill.verified_evidence_sentences only to understand the situation. In context_grounded mode,
do not copy or repeat them; the Worker inserts those verified metric sentences after your response.
In verified_answer_rewrite mode, at least one evidence bullet must explain a supplied calculation_basis in
qualitative language without repeating a measurement or quantity from verified_answer.
Outside the verbatim verified_answer required for verified_answer_rewrite mode, the summary MUST contain no
measurement value or quantity, whether written with digits or words.
This includes counts, output, plan/actual, rates, percentages, dates, times, durations, and thresholds.
Outside that verbatim verified_answer, digits are allowed only when they are part of an exact machine, line,
or Part identifier copied unchanged from the input. The title may contain the exact supplied date.
When the evidence is primarily numeric, state only a qualitative condition, limitation, or next action.
For example, write "최근 측정 구간의 추세를 기준으로 예상 결과를 확인했습니다" instead of
copying a duration or projected quantity. Refer to an unverified numeric specification as "해당 규격".
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
    conversation_history = (payload.get("conversation_history") or [])[-8:]
    question_context = " ".join([
        str(payload.get("question") or ""),
        *(str(item.get("content") or "") for item in conversation_history if isinstance(item, dict)),
    ])
    compact_tables = prioritize_verified_rows(
        verified_context.get("tables") or [],
        question_context,
    )
    llm_payload = {
        "language": "zh" if payload.get("language") == "zh" else "ko",
        "date": payload.get("date"),
        "question": payload.get("question") or "",
        "conversation_history": conversation_history,
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
            "Return specific but compact Korean JSON if language is ko, Chinese JSON if language is zh. "
            "Structure summary as conclusion, two or three evidence bullets, then one or two items to check. "
            "Do not expose private reasoning; provide only the evidence-backed final explanation. "
            "Do not perform arithmetic. For verified_answer_rewrite, copy verified_answer verbatim once at the "
            "start of the conclusion and write no other measurement or quantity. For context_grounded, write no "
            "measurement or quantity; the Worker will insert verified metrics. "
            "Only exact identifier digits may remain. "
            "Use only facts present in verified_answer, verified_facts, verified_tables, or historical_snapshots."
        ),
    }
    llm_payload["analysis_skill"] = build_skill_payload(llm_payload)
    return llm_payload


def enrich_summary(summary: str, llm_payload: dict[str, Any]) -> str:
    language = "zh" if llm_payload.get("language") == "zh" else "ko"
    skill_payload = llm_payload.get("analysis_skill")
    if not isinstance(skill_payload, dict):
        return summary
    return insert_verified_metrics(summary, skill_payload, language)


def build_grounding_payload(job: dict[str, Any]) -> dict[str, Any]:
    """Return authoritative evidence only, excluding user-authored chat text."""
    llm_payload = build_llm_payload(job)
    return {
        "date": llm_payload.get("date"),
        "verified_answer": llm_payload.get("verified_answer"),
        "verified_facts": llm_payload.get("verified_facts"),
        "verified_tables": llm_payload.get("verified_tables"),
        "historical_snapshots": llm_payload.get("historical_snapshots"),
        "analysis_skill": llm_payload.get("analysis_skill"),
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
