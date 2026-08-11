"""Gemma-only daily quality-attention scheduling and result hardening."""

from __future__ import annotations

from datetime import date, datetime, time
import re
from typing import Any

from django.db import connection, transaction
from django.utils import timezone

from production.ai_metrics import SHANGHAI_TZ
from quality.daily_attention import (
    QUALITY_ATTENTION_AI_SCHEMA_VERSION,
    build_daily_quality_attention_ai_input,
    quality_attention_plan_snapshot,
)

from .models import AiJob


QUALITY_DAILY_MODE = "daily_attention_summary"
QUALITY_DAILY_TRIGGER = "daily_attention"
QUALITY_DAILY_MODEL_ID = "gemma4_26b_a4b"
QUALITY_DAILY_LANGUAGE = "bilingual"
QUALITY_DAILY_START_HOUR = 7
QUALITY_DAILY_PLAN_DEBOUNCE_SECONDS = 5 * 60
QUALITY_DAILY_RETRY_COOLDOWN_SECONDS = 15 * 60
QUALITY_DAILY_ACTIVE_STATUSES = (
    AiJob.STATUS_PENDING,
    AiJob.STATUS_CLAIMED,
    AiJob.STATUS_RUNNING,
)
QUALITY_DAILY_DISCLAIMER = {
    "ko": "과거 품질 이력이며 현재 불량 발생을 의미하지 않습니다.",
    "zh": "仅为历史品质记录，不代表当前正在发生不良。",
}
QUALITY_UNKNOWN_PROBLEM_TYPE = {"ko": "유형 미분류", "zh": "类型未分类"}
QUALITY_UNKNOWN_LOCATION = {"ko": "위치 미확인", "zh": "位置未确认"}


def _is_retryable_job(job: AiJob | None) -> bool:
    if job is None:
        return False
    if job.status in {AiJob.STATUS_FAILED, AiJob.STATUS_CANCELLED}:
        return True
    return bool(
        job.status == AiJob.STATUS_COMPLETED
        and isinstance(job.result_payload, dict)
        and job.result_payload.get("llm_fallback") is True
    )


def is_daily_quality_summary_job(job: AiJob) -> bool:
    scope = job.scope if isinstance(job.scope, dict) else {}
    return (
        job.job_type == AiJob.JOB_TYPE_QUALITY_IMAGE
        and scope.get("mode") == QUALITY_DAILY_MODE
        and scope.get("trigger") == QUALITY_DAILY_TRIGGER
    )


def _local_now(now: datetime | None = None) -> datetime:
    value = now or timezone.now()
    if timezone.is_naive(value):
        value = timezone.make_aware(value, SHANGHAI_TZ)
    return value.astimezone(SHANGHAI_TZ)


def _parse_iso_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, SHANGHAI_TZ)
    return parsed


def _lock_schedule_key(target_date: date, source_plan_hash: str) -> None:
    """Serialize date/hash creation on PostgreSQL without adding a schema row."""

    if connection.vendor != "postgresql":
        return
    lock_key = f"quality-daily:{target_date.isoformat()}:{source_plan_hash}"
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", [lock_key])


def enqueue_daily_quality_summary(now: datetime | None = None) -> dict[str, Any]:
    """Create one job per local date and stable plan hash, at/after 07:00.

    The current plan's database/change-log timestamp is the debounce clock.
    Calling this function every minute is safe and is the intended operation.
    """

    local_now = _local_now(now)
    target_date = local_now.date()
    if local_now.time() < time(QUALITY_DAILY_START_HOUR, 0):
        return {
            "status": "before_schedule",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
        }

    plan_state = quality_attention_plan_snapshot(target_date)
    source_plan_hash = plan_state.get("source_plan_hash")
    if not source_plan_hash or not plan_state.get("plan_group_count"):
        return {
            "status": "no_plan",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
            "source_plan_hash": None,
        }

    filters = {
        "job_type": AiJob.JOB_TYPE_QUALITY_IMAGE,
        "scope__mode": QUALITY_DAILY_MODE,
        "scope__date": target_date.isoformat(),
        "scope__source_plan_hash": source_plan_hash,
    }
    existing = AiJob.objects.filter(**filters).order_by("-id").first()
    if existing and not _is_retryable_job(existing):
        return {
            "status": "exists",
            "date": target_date.isoformat(),
            "created": False,
            "job": existing,
            "source_plan_hash": source_plan_hash,
        }
    if existing and _is_retryable_job(existing):
        last_attempt_at = existing.completed_at or existing.updated_at
        retry_age = max(0, int((local_now - last_attempt_at.astimezone(SHANGHAI_TZ)).total_seconds()))
        if retry_age < QUALITY_DAILY_RETRY_COOLDOWN_SECONDS:
            return {
                "status": "retry_cooldown",
                "date": target_date.isoformat(),
                "created": False,
                "job": existing,
                "source_plan_hash": source_plan_hash,
                "retry_after_seconds": QUALITY_DAILY_RETRY_COOLDOWN_SECONDS - retry_age,
            }

    changed_at = _parse_iso_datetime(plan_state.get("source_plan_last_changed_at"))
    stable_seconds = (
        max(0, int((local_now - changed_at.astimezone(SHANGHAI_TZ)).total_seconds()))
        if changed_at
        else QUALITY_DAILY_PLAN_DEBOUNCE_SECONDS
    )
    if stable_seconds < QUALITY_DAILY_PLAN_DEBOUNCE_SECONDS:
        return {
            "status": "debouncing",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
            "source_plan_hash": source_plan_hash,
            "retry_after_seconds": QUALITY_DAILY_PLAN_DEBOUNCE_SECONDS - stable_seconds,
        }

    input_payload = build_daily_quality_attention_ai_input(
        target_date,
        model_id=QUALITY_DAILY_MODEL_ID,
    )
    # The plan can change while the all-history evidence is being assembled.
    if input_payload.get("source_plan_hash") != source_plan_hash:
        return {
            "status": "plan_changed_during_build",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
            "source_plan_hash": input_payload.get("source_plan_hash"),
        }

    scope = {
        "mode": QUALITY_DAILY_MODE,
        "trigger": QUALITY_DAILY_TRIGGER,
        "date": target_date.isoformat(),
        "language": QUALITY_DAILY_LANGUAGE,
        "model_id": QUALITY_DAILY_MODEL_ID,
        "source_plan_hash": source_plan_hash,
        "plan_stable_since": plan_state.get("source_plan_last_changed_at"),
    }
    with transaction.atomic():
        _lock_schedule_key(target_date, source_plan_hash)
        existing = (
            AiJob.objects.select_for_update().filter(**filters).order_by("-id").first()
        )
        if existing and not _is_retryable_job(existing):
            return {
                "status": "exists",
                "date": target_date.isoformat(),
                "created": False,
                "job": existing,
                "source_plan_hash": source_plan_hash,
            }
        if existing and _is_retryable_job(existing):
            last_attempt_at = existing.completed_at or existing.updated_at
            retry_age = max(0, int((local_now - last_attempt_at.astimezone(SHANGHAI_TZ)).total_seconds()))
            if retry_age < QUALITY_DAILY_RETRY_COOLDOWN_SECONDS:
                return {
                    "status": "retry_cooldown",
                    "date": target_date.isoformat(),
                    "created": False,
                    "job": existing,
                    "source_plan_hash": source_plan_hash,
                    "retry_after_seconds": QUALITY_DAILY_RETRY_COOLDOWN_SECONDS - retry_age,
                }
            existing.status = AiJob.STATUS_PENDING
            existing.scope = scope
            existing.input_payload = input_payload
            existing.result_payload = {}
            existing.error_message = ""
            existing.claimed_by = ""
            existing.claimed_at = None
            existing.started_at = None
            existing.completed_at = None
            existing.model_name = ""
            existing.prompt_version = ""
            existing.save(update_fields=[
                "status",
                "scope",
                "input_payload",
                "result_payload",
                "error_message",
                "claimed_by",
                "claimed_at",
                "started_at",
                "completed_at",
                "model_name",
                "prompt_version",
                "updated_at",
            ])
            return {
                "status": "retried",
                "date": target_date.isoformat(),
                "created": False,
                "job": existing,
                "source_plan_hash": source_plan_hash,
            }
        # A superseded active job must never publish after a stable replacement
        # plan has been observed.
        AiJob.objects.filter(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status__in=QUALITY_DAILY_ACTIVE_STATUSES,
            scope__mode=QUALITY_DAILY_MODE,
            scope__date=target_date.isoformat(),
        ).exclude(scope__source_plan_hash=source_plan_hash).update(
            status=AiJob.STATUS_CANCELLED,
            completed_at=timezone.now(),
            error_message="Superseded by a stable production-plan fingerprint.",
            updated_at=timezone.now(),
        )
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope=scope,
            input_payload=input_payload,
            created_by=None,
        )
    return {
        "status": "created",
        "date": target_date.isoformat(),
        "created": True,
        "job": job,
        "source_plan_hash": source_plan_hash,
    }


def _bilingual(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {"ko": "", "zh": ""}
    return {
        "ko": str(value.get("ko") or "").strip()[:1200],
        "zh": str(value.get("zh") or "").strip()[:1200],
    }


def _contains_current_defect_claim(value: str, language: str) -> bool:
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    if not normalized:
        return False
    if language == "zh":
        if any(negation in normalized for negation in ("不代表", "并非", "没有", "未发生")):
            return False
        return bool(re.search(r"(?:当前|正在).{0,20}(?:不良|缺陷).{0,20}(?:发生|存在|确认)", normalized))
    if any(negation in normalized for negation in ("의미하지 않", "아니며", "아닙니다", "발생하지 않")):
        return False
    return bool(re.search(r"(?:현재|지금).{0,20}(?:불량|품질 문제).{0,20}(?:발생|확인|있)", normalized))


def _safe_bilingual(value: Any, *, fallback: dict[str, str] | None = None) -> dict[str, str]:
    result = _bilingual(value)
    fallback = fallback or {"ko": "", "zh": ""}
    for language in ("ko", "zh"):
        if not result[language] or _contains_current_defect_claim(result[language], language):
            result[language] = fallback.get(language, "")
    return result


def _string_list(value: Any, *, limit: int = 4) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip()[:300] for item in value if str(item or "").strip()][:limit]


def _safe_bilingual_list(value: Any) -> dict[str, list[str]]:
    if not isinstance(value, dict):
        return {"ko": [], "zh": []}
    result: dict[str, list[str]] = {"ko": [], "zh": []}
    for language in ("ko", "zh"):
        for text in _string_list(value.get(language)):
            if not _contains_current_defect_claim(text, language):
                result[language].append(text)
    return result


def _candidate_has_current_defect_claim(candidate: dict[str, Any]) -> bool:
    bilingual_values: list[Any] = [candidate.get("summary")]
    checkpoint_values: list[Any] = []
    for item in candidate.get("attention_items") or []:
        if not isinstance(item, dict):
            continue
        bilingual_values.append(item.get("headline"))
        checkpoints = item.get("checkpoints")
        if isinstance(checkpoints, dict):
            checkpoint_values.append(checkpoints)
        for group_name in ("problem_types", "locations"):
            for group in item.get(group_name) or []:
                if isinstance(group, dict):
                    bilingual_values.append(group.get("label"))
    for value in bilingual_values:
        texts = _bilingual(value)
        if any(
            _contains_current_defect_claim(texts[language], language)
            for language in ("ko", "zh")
        ):
            return True
    for value in checkpoint_values:
        for language in ("ko", "zh"):
            if any(
                _contains_current_defect_claim(text, language)
                for text in _string_list(value.get(language))
            ):
                return True
    return False


def _classified_groups(
    value: Any,
    valid_report_ids: set[int],
    evidence_report_ids: dict[str, set[int]],
    missing_evidence_keys: set[str],
    unknown_label: dict[str, str],
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    result = []
    used_report_ids: set[int] = set()
    used_evidence_keys: set[str] = set()
    missing_report_ids = {
        report_id
        for key in missing_evidence_keys
        for report_id in evidence_report_ids.get(key, set())
    }
    for raw in value[:8]:
        if not isinstance(raw, dict):
            continue
        labels = _bilingual(raw.get("label"))
        if not labels["ko"] or not labels["zh"]:
            continue
        if any(
            _contains_current_defect_claim(labels[language], language)
            for language in ("ko", "zh")
        ):
            continue
        source_ids = []
        for report_id in raw.get("source_report_ids") or []:
            if (
                isinstance(report_id, int)
                and report_id in valid_report_ids
                and report_id not in missing_report_ids
                and report_id not in used_report_ids
                and report_id not in source_ids
            ):
                source_ids.append(report_id)
        source_evidence_keys = []
        for evidence_key in raw.get("source_evidence_keys") or []:
            key = str(evidence_key or "")
            if (
                key not in evidence_report_ids
                or key in missing_evidence_keys
                or key in used_evidence_keys
                or key in source_evidence_keys
            ):
                continue
            source_evidence_keys.append(key)
            for report_id in sorted(evidence_report_ids[key]):
                if (
                    report_id in valid_report_ids
                    and report_id not in used_report_ids
                    and report_id not in source_ids
                ):
                    source_ids.append(report_id)
        if not source_ids:
            continue
        used_report_ids.update(source_ids)
        used_evidence_keys.update(source_evidence_keys)
        existing = next((item for item in result if item["label"] == labels), None)
        if existing:
            existing["source_evidence_keys"].extend(source_evidence_keys)
            existing["source_report_ids"].extend(source_ids)
            existing["count"] = len(existing["source_report_ids"])
        else:
            result.append({
                "label": labels,
                "count": len(source_ids),
                "source_evidence_keys": source_evidence_keys,
                "source_report_ids": source_ids,
            })

    # Every phenomenon aggregate remains represented.  Missing phenomenon text
    # and any omitted/invalid LLM classification are server-owned unknowns.
    uncovered_keys = [
        key for key in evidence_report_ids if key not in used_evidence_keys
    ]
    uncovered_ids = sorted({
        report_id
        for key in uncovered_keys
        for report_id in evidence_report_ids[key]
        if report_id not in used_report_ids
    })
    if uncovered_ids:
        existing = next((item for item in result if item["label"] == unknown_label), None)
        if existing:
            existing["source_evidence_keys"].extend(uncovered_keys)
            existing["source_report_ids"].extend(uncovered_ids)
            existing["count"] = len(existing["source_report_ids"])
        else:
            result.append({
                "label": dict(unknown_label),
                "count": len(uncovered_ids),
                "source_evidence_keys": uncovered_keys,
                "source_report_ids": uncovered_ids,
            })
    return result


def restore_authoritative_quality_result(job: AiJob, worker_result: Any) -> dict[str, Any]:
    """Discard invented source rows/counts and merge prose onto server evidence."""

    source = job.input_payload if isinstance(job.input_payload, dict) else {}
    candidate = worker_result if isinstance(worker_result, dict) else {}
    generation_source = str(candidate.get("source") or "")[:64]
    server_safety_rejected = _candidate_has_current_defect_claim(candidate)
    llm_fallback = (
        candidate.get("llm_fallback") is True
        or generation_source != "local_llm_rewrite"
        or server_safety_rejected
    )
    llm_fallback_code = str(candidate.get("llm_fallback_code") or "")[:64]
    if llm_fallback and not llm_fallback_code:
        llm_fallback_code = (
            "server_safety_rejected"
            if server_safety_rejected
            else "unverified_generation_source"
        )
    fallback_summary = {
        "ko": "당일 생산계획과 연결된 과거 품질 이력을 확인했습니다.",
        "zh": "已核对与当日生产计划关联的历史品质记录。",
    }
    worker_items = {
        str(item.get("source_key")): item
        for item in candidate.get("attention_items") or []
        if isinstance(item, dict) and item.get("source_key")
    }
    evidence_catalog = {
        str(item.get("evidence_key")): item
        for item in source.get("evidence_catalog") or []
        if isinstance(item, dict) and item.get("evidence_key")
    }
    restored_items = []
    for source_item in source.get("items") or []:
        if not isinstance(source_item, dict):
            continue
        source_key = str(source_item.get("source_key") or "")
        worker_item = worker_items.get(source_key)
        if not worker_item:
            continue
        evidence = evidence_catalog.get(str(source_item.get("evidence_key") or ""), {})
        report_ids = {
            ref.get("report_id")
            for ref in evidence.get("report_refs") or source_item.get("report_refs") or []
            if isinstance(ref, dict) and isinstance(ref.get("report_id"), int)
        }
        evidence_report_ids: dict[str, set[int]] = {}
        missing_evidence_keys: set[str] = set()
        # Type/location classifications must be grounded in a recorded
        # phenomenon.  Dispositions and action results are context only.
        for aggregate in evidence.get("phenomena") or []:
            if not isinstance(aggregate, dict) or not aggregate.get("evidence_key"):
                continue
            evidence_report_ids[str(aggregate["evidence_key"])] = {
                report_id
                for report_id in aggregate.get("report_ids") or []
                if isinstance(report_id, int) and report_id in report_ids
            }
            if aggregate.get("is_missing_text") is True:
                missing_evidence_keys.add(str(aggregate["evidence_key"]))
        restored_items.append({
            "source_key": source_key,
            "machine_name": source_item.get("machine_name") or "",
            "machine_number": source_item.get("machine_number"),
            "sequence": source_item.get("sequence"),
            "part_prefix": source_item.get("part_prefix") or "",
            "part_nos": list(source_item.get("part_nos") or []),
            "model_names": list(source_item.get("model_names") or []),
            "matching_report_count": int(source_item.get("matching_report_count") or 0),
            "latest_report_dt": source_item.get("latest_report_dt"),
            "match_basis": source_item.get("match_basis"),
            "headline": _safe_bilingual(worker_item.get("headline")),
            "checkpoints": _safe_bilingual_list(worker_item.get("checkpoints")),
            "problem_types": _classified_groups(
                worker_item.get("problem_types"),
                report_ids,
                evidence_report_ids,
                missing_evidence_keys,
                QUALITY_UNKNOWN_PROBLEM_TYPE,
            ),
            "locations": _classified_groups(
                worker_item.get("locations"),
                report_ids,
                evidence_report_ids,
                missing_evidence_keys,
                QUALITY_UNKNOWN_LOCATION,
            ),
            "evidence_report_ids": sorted(report_ids),
        })

    return {
        "schema_version": source.get("schema_version") or QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "business_date": source.get("date"),
        "source_plan_hash": source.get("source_plan_hash"),
        "model_id": source.get("model_id") or QUALITY_DAILY_MODEL_ID,
        "summary": _safe_bilingual(candidate.get("summary"), fallback=fallback_summary),
        "attention_items": restored_items,
        "disclaimer": dict(source.get("disclaimer") or QUALITY_DAILY_DISCLAIMER),
        "totals": dict(source.get("totals") or {}),
        "match_basis": (source.get("summary_basis") or {}).get("match_basis") or "part_prefix_9",
        "history_coverage": (source.get("summary_basis") or {}).get("history_coverage") or "all_history",
        "generated_at": timezone.now().isoformat(),
        "warnings": _string_list(candidate.get("warnings"), limit=10),
        "generation_source": generation_source or "unverified",
        "llm_fallback": llm_fallback,
        "llm_fallback_code": llm_fallback_code,
    }


def _public_completed_result(job: AiJob, target_date: date, source_plan_hash: str) -> dict[str, Any]:
    result = job.result_payload if isinstance(job.result_payload, dict) else {}
    generation_source = str(result.get("generation_source") or "")[:64]
    llm_fallback = (
        result.get("llm_fallback") is True
        or generation_source != "local_llm_rewrite"
    )
    public_items = []
    for item in result.get("attention_items") or []:
        if not isinstance(item, dict):
            continue
        public_items.append({
            key: item.get(key)
            for key in (
                "source_key",
                "machine_name",
                "machine_number",
                "part_prefix",
                "part_nos",
                "model_names",
                "matching_report_count",
                "latest_report_dt",
                "headline",
                "checkpoints",
                "problem_types",
                "locations",
            )
        })
        for group_key in ("problem_types", "locations"):
            public_items[-1][group_key] = [
                {
                    "label": group.get("label"),
                    "count": group.get("count"),
                    "source_evidence_keys": list(group.get("source_evidence_keys") or []),
                }
                for group in item.get(group_key) or []
                if isinstance(group, dict)
            ]
    return {
        "status": "ready",
        "business_date": target_date.isoformat(),
        "source_plan_hash": source_plan_hash,
        "generated_at": result.get("generated_at"),
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "model_id": QUALITY_DAILY_MODEL_ID,
        "model_name": job.model_name or "",
        "schema_version": result.get("schema_version") or QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "summary": _bilingual(result.get("summary")),
        "disclaimer": dict(result.get("disclaimer") or QUALITY_DAILY_DISCLAIMER),
        "totals": dict(result.get("totals") or {}),
        "match_basis": result.get("match_basis") or "part_prefix_9",
        "history_coverage": result.get("history_coverage") or "all_history",
        "attention_items": public_items,
        "reason": None,
        "generation_source": generation_source or "unverified",
        "llm_fallback": llm_fallback,
        "llm_fallback_code": str(
            result.get("llm_fallback_code")
            or ("unverified_generation_source" if llm_fallback else "")
        )[:64],
    }


def quality_summary_for_overview(target_date: date) -> dict[str, Any]:
    """Return only an exact-plan completed summary, plus explicit fallback state."""

    plan_state = quality_attention_plan_snapshot(target_date)
    source_plan_hash = plan_state.get("source_plan_hash")
    base = {
        "status": "unavailable",
        "business_date": target_date.isoformat(),
        "source_plan_hash": source_plan_hash,
        "generated_at": None,
        "completed_at": None,
        "model_id": QUALITY_DAILY_MODEL_ID,
        "model_name": "",
        "schema_version": QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "summary": None,
        "disclaimer": dict(QUALITY_DAILY_DISCLAIMER),
        "totals": None,
        "match_basis": "part_prefix_9",
        "history_coverage": "all_history",
        "attention_items": [],
        "reason": "no_plan" if not source_plan_hash else "not_generated",
        "generation_source": None,
        "llm_fallback": False,
        "llm_fallback_code": "",
    }
    if not source_plan_hash:
        return base

    jobs = AiJob.objects.filter(
        job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
        scope__mode=QUALITY_DAILY_MODE,
        scope__date=target_date.isoformat(),
    )
    exact = jobs.filter(scope__source_plan_hash=source_plan_hash)
    completed = exact.filter(status=AiJob.STATUS_COMPLETED).order_by("-completed_at", "-id").first()
    if completed:
        public = _public_completed_result(completed, target_date, source_plan_hash)
        if public.get("llm_fallback") is True:
            return {
                **base,
                "completed_at": public.get("completed_at"),
                "generation_source": public.get("generation_source"),
                "llm_fallback": True,
                "llm_fallback_code": public.get("llm_fallback_code"),
                "reason": "llm_fallback",
            }
        return public
    if exact.filter(status__in=QUALITY_DAILY_ACTIVE_STATUSES).exists():
        return {**base, "status": "pending", "reason": "generation_pending"}
    if exact.filter(status=AiJob.STATUS_FAILED).exists():
        return {**base, "reason": "generation_failed"}
    if jobs.filter(status=AiJob.STATUS_COMPLETED).exists():
        return {**base, "status": "stale", "reason": "plan_changed"}
    return base
