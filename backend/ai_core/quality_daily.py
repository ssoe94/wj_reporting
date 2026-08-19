"""Qwen 3.8 daily quality-attention scheduling and result hardening."""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, time
import hashlib
import re
from typing import Any

from django.db import DatabaseError, connection, transaction
from django.utils import timezone

from production.ai_metrics import SHANGHAI_TZ
from quality.daily_attention import (
    QUALITY_ATTENTION_AI_SCHEMA_VERSION,
    QUALITY_DAILY_REPORT_SCHEMA_VERSION,
    build_daily_quality_attention_ai_input,
    quality_attention_evidence_snapshot,
    quality_attention_plan_snapshot,
)

from .model_registry import QUALITY_DAILY_MODEL_ID
from .models import AiJob


QUALITY_DAILY_MODE = "daily_attention_summary"
QUALITY_DAILY_TRIGGER = "daily_attention"
QUALITY_DAILY_LANGUAGE = "bilingual"
QUALITY_DAILY_START_HOUR = 7
QUALITY_DAILY_PLAN_DEBOUNCE_SECONDS = 5 * 60
QUALITY_DAILY_EVIDENCE_DEBOUNCE_SECONDS = 5 * 60
# Morning shift summaries should recover promptly from a bounded local-model
# failure without creating a tight retry loop.
QUALITY_DAILY_RETRY_COOLDOWN_SECONDS = 5 * 60
QUALITY_DAILY_PAGE_REPORT_SCHEMA_VERSION = "quality-daily-page-report.v1"
QUALITY_DAILY_NARRATIVE_SCHEMA_VERSION = "quality-daily-report-narrative.v1"
QUALITY_DAILY_PUBLIC_CONTRACT_VERSION = "quality-daily-public-report.v2"
QUALITY_DAILY_EXPECTED_PROMPT_VERSION = "quality-daily-attention-qwen38-v5"
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


def _is_retryable_job(job: AiJob | None) -> bool:
    if job is None:
        return False
    if job.status in {AiJob.STATUS_FAILED, AiJob.STATUS_CANCELLED}:
        return True
    if job.status != AiJob.STATUS_COMPLETED or not isinstance(job.result_payload, dict):
        return False
    if job.prompt_version != QUALITY_DAILY_EXPECTED_PROMPT_VERSION:
        return True
    if job.result_payload.get("llm_fallback") is True:
        return True
    report = job.result_payload.get("report")
    return not (
        isinstance(report, dict)
        and report.get("schema_version") == QUALITY_DAILY_NARRATIVE_SCHEMA_VERSION
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


def _evidence_stable_seconds(
    *,
    local_now: datetime,
    source_evidence_last_changed_at: Any,
) -> int:
    changed_at = _parse_iso_datetime(source_evidence_last_changed_at)
    return (
        max(0, int((local_now - changed_at.astimezone(SHANGHAI_TZ)).total_seconds()))
        if changed_at
        else QUALITY_DAILY_EVIDENCE_DEBOUNCE_SECONDS
    )


def enqueue_daily_quality_summary(now: datetime | None = None) -> dict[str, Any]:
    """Create one job per local date and stable plan/evidence hash, at/after 07:00.

    Plan timestamps and relevant quality-report update timestamps are debounce
    clocks.  The evidence snapshot is cached for five minutes, so calling this
    function every minute is safe without scanning full history every minute.
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

    evidence_state = quality_attention_evidence_snapshot(target_date)
    source_evidence_hash = str(evidence_state.get("source_evidence_hash") or "")
    if not source_evidence_hash:
        return {
            "status": "evidence_unavailable",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
            "source_plan_hash": source_plan_hash,
            "source_evidence_hash": None,
        }

    filters = {
        "job_type": AiJob.JOB_TYPE_QUALITY_IMAGE,
        "scope__mode": QUALITY_DAILY_MODE,
        "scope__trigger": QUALITY_DAILY_TRIGGER,
        "scope__date": target_date.isoformat(),
        "scope__source_plan_hash": source_plan_hash,
        "scope__source_evidence_hash": source_evidence_hash,
    }
    existing = AiJob.objects.filter(**filters).order_by("-id").first()
    if existing and not _is_retryable_job(existing):
        return {
            "status": "exists",
            "date": target_date.isoformat(),
            "created": False,
            "job": existing,
            "source_plan_hash": source_plan_hash,
            "source_evidence_hash": source_evidence_hash,
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
                "source_evidence_hash": source_evidence_hash,
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
            "source_evidence_hash": source_evidence_hash,
            "retry_after_seconds": QUALITY_DAILY_PLAN_DEBOUNCE_SECONDS - stable_seconds,
        }

    prior_same_plan = AiJob.objects.filter(
        job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
        scope__mode=QUALITY_DAILY_MODE,
        scope__trigger=QUALITY_DAILY_TRIGGER,
        scope__date=target_date.isoformat(),
        scope__source_plan_hash=source_plan_hash,
    ).exclude(scope__source_evidence_hash=source_evidence_hash)
    if prior_same_plan.exists():
        evidence_stable_seconds = _evidence_stable_seconds(
            local_now=local_now,
            source_evidence_last_changed_at=evidence_state.get(
                "source_evidence_last_changed_at"
            ),
        )
        if evidence_stable_seconds < QUALITY_DAILY_EVIDENCE_DEBOUNCE_SECONDS:
            return {
                "status": "evidence_debouncing",
                "date": target_date.isoformat(),
                "created": False,
                "job": None,
                "source_plan_hash": source_plan_hash,
                "source_evidence_hash": source_evidence_hash,
                "retry_after_seconds": (
                    QUALITY_DAILY_EVIDENCE_DEBOUNCE_SECONDS
                    - evidence_stable_seconds
                ),
            }

    input_payload = build_daily_quality_attention_ai_input(
        target_date,
        model_id=QUALITY_DAILY_MODEL_ID,
    )
    input_payload["selection_contract_version"] = QUALITY_DAILY_EXPECTED_PROMPT_VERSION
    # The plan can change while the all-history evidence is being assembled.
    if input_payload.get("source_plan_hash") != source_plan_hash:
        return {
            "status": "plan_changed_during_build",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
            "source_plan_hash": input_payload.get("source_plan_hash"),
            "source_evidence_hash": input_payload.get("source_evidence_hash"),
        }
    if input_payload.get("source_evidence_hash") != source_evidence_hash:
        quality_attention_evidence_snapshot(target_date, force_refresh=True)
        return {
            "status": "source_changed_during_build",
            "date": target_date.isoformat(),
            "created": False,
            "job": None,
            "source_plan_hash": input_payload.get("source_plan_hash"),
            "source_evidence_hash": input_payload.get("source_evidence_hash"),
        }

    scope = {
        "mode": QUALITY_DAILY_MODE,
        "trigger": QUALITY_DAILY_TRIGGER,
        "date": target_date.isoformat(),
        "language": QUALITY_DAILY_LANGUAGE,
        "model_id": QUALITY_DAILY_MODEL_ID,
        "selection_contract_version": QUALITY_DAILY_EXPECTED_PROMPT_VERSION,
        "source_plan_hash": source_plan_hash,
        "source_evidence_hash": source_evidence_hash,
        "plan_stable_since": plan_state.get("source_plan_last_changed_at"),
        "evidence_stable_since": evidence_state.get(
            "source_evidence_last_changed_at"
        ),
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
                "source_evidence_hash": source_evidence_hash,
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
                    "source_evidence_hash": source_evidence_hash,
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
                "source_evidence_hash": source_evidence_hash,
            }
        # A superseded active job must never publish after a stable replacement
        # plan has been observed.
        AiJob.objects.filter(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status__in=QUALITY_DAILY_ACTIVE_STATUSES,
            scope__mode=QUALITY_DAILY_MODE,
            scope__trigger=QUALITY_DAILY_TRIGGER,
            scope__date=target_date.isoformat(),
        ).exclude(
            scope__source_plan_hash=source_plan_hash,
            scope__source_evidence_hash=source_evidence_hash,
        ).update(
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
        "source_evidence_hash": source_evidence_hash,
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
        # Remove only the supported epistemic caveat.  A blanket negation
        # bypass would let a sentence combine a current-defect assertion with
        # an unrelated ``不代表`` clause and evade the server guard.
        normalized = re.sub(
            r"(?:仅为|只是|本摘要)?[^。；]{0,30}不代表(?:当前|目前)(?:正在)?发生(?:不良|缺陷)",
            "",
            normalized,
        )
        return bool(
            re.search(
                r"(?:当前|正在|目前|今天|今日).{0,20}(?:不良|缺陷|异常|问题).{0,20}(?:发生|出现|存在|确认)",
                normalized,
            )
            or re.search(r"(?:不良|缺陷).{0,8}(?:正在发生|正在出现|已确认)", normalized)
        )
    normalized = re.sub(
        r"(?:과거|이력|기록)[^.]{0,40}(?:현재|금일|오늘)\s*(?:불량|결함)\s*발생을?\s*의미하지\s*않(?:습니다|는다|음)",
        "",
        normalized,
    )
    return bool(
        re.search(
            r"(?:현재|지금|금일|오늘).{0,20}(?:불량|품질 문제|결함|이상|문제).{0,20}(?:발생|확인|있|존재|나오)",
            normalized,
        )
        or re.search(r"(?:불량|결함).{0,8}(?:발생\s*중|나오고|확인됨)", normalized)
    )


def _contains_root_cause_claim(value: str, language: str) -> bool:
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    if not normalized:
        return False
    if language == "zh":
        return bool(re.search(
            r"(?:原因(?:是|为|為)|由于|由於|因为|因為|导致|導致|引发|引發|造成|可能|疑似|推测|推測|推断|推斷)",
            normalized,
        ))
    return bool(re.search(
        r"(?:원인(?:은|이|으로)?|때문에|(?:으)?로\s*인해|유발|초래|야기|탓|가능성|추정|의심|기인)",
        normalized,
    ))


def _contains_unsupported_action_or_rate(value: str, language: str) -> bool:
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    if not normalized:
        return False
    if language == "zh":
        return bool(re.search(
            r"(?:不良率|缺陷率|更换|更換|修理|维修|維修|报废|報廢|隔离|隔離|返工|停产|停產|清洗|研磨|增压|增壓|减压|減壓|调整温度|調整溫度|变更条件|變更條件)",
            normalized,
        ))
    return bool(re.search(
        r"(?:불량률|결함률|교체|수리|폐기|격리|재작업|중단|세척|연마|증압|감압|온도(?:를)?\s*조정|조건(?:을)?\s*변경)",
        normalized,
    ))


def _contains_unsupported_claim(value: str, language: str) -> bool:
    return (
        _contains_current_defect_claim(value, language)
        or _contains_root_cause_claim(value, language)
        or _contains_unsupported_action_or_rate(value, language)
    )


def _contains_unverified_number(value: str) -> bool:
    text = value or ""
    return bool(
        re.search(r"(?:\d|%|℃|±)", text)
        or re.search(
            r"(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:건|회|개|가지|항목)",
            text,
        )
        or re.search(r"[零一二三四五六七八九十百千万两]+\s*(?:条|次|项|个|种|件)", text)
    )


def _safe_bilingual(value: Any, *, fallback: dict[str, str] | None = None) -> dict[str, str]:
    result = _bilingual(value)
    fallback = fallback or {"ko": "", "zh": ""}
    for language in ("ko", "zh"):
        if (
            not result[language]
            or _contains_unsupported_claim(result[language], language)
            or _contains_unverified_number(result[language])
        ):
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
            if (
                not _contains_unsupported_claim(text, language)
                and not _contains_unverified_number(text)
            ):
                result[language].append(text)
    return result


def _authoritative_summary(source: dict[str, Any]) -> dict[str, str]:
    return {
        "ko": "당일 생산계획과 연결된 과거 품질 이력을 서버 검증 기준으로 정리했습니다.",
        "zh": "已按服务器验证口径整理与当日生产计划关联的历史品质记录。",
    }


def _authoritative_attention_headline() -> dict[str, str]:
    return {
        "ko": "해당 계획 대상과 연결된 과거 품질 이력을 우선 확인하세요.",
        "zh": "请优先确认与该计划对象关联的历史品质记录。",
    }


def _authoritative_attention_checkpoints() -> dict[str, list[str]]:
    return {
        "ko": ["교대 전 서버가 연결한 과거 문제 현상을 확인하세요."],
        "zh": ["交接班前请确认服务器关联的历史问题现象。"],
    }


def _compact_public_revision(
    source_plan_hash: str | None,
    source_evidence_hash: str | None,
) -> str | None:
    """Return one opaque public revision without leaking internal fingerprints."""

    if not source_plan_hash or not source_evidence_hash:
        return None
    material = (
        f"{QUALITY_DAILY_PUBLIC_CONTRACT_VERSION}\0"
        f"{source_plan_hash}\0{source_evidence_hash}"
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:12]


def _public_deterministic_report(value: dict[str, Any]) -> dict[str, Any]:
    """Project numeric report metrics without internal grounding identifiers.

    Evidence keys and free recorded text are used only inside the job/restore
    pipeline.  The authenticated page receives canonical metrics, counts,
    dates and plan impact scope, which are sufficient to audit every public
    sentence without revealing implementation fingerprints.
    """

    result = deepcopy(value if isinstance(value, dict) else {})
    for group_name in (
        "problem_types",
        "problem_location_pairs",
        "occurrence_locations",
    ):
        for metric in result.get(group_name) or []:
            if not isinstance(metric, dict):
                continue
            metric.pop("source_evidence_keys", None)
            metric.pop("recorded_text", None)
            if metric.get("classification_basis") == "unclassified_recorded_text_hash":
                metric["label"] = dict(QUALITY_UNKNOWN_PROBLEM_TYPE)
                metric["classification_basis"] = "unclassified"
    calculation_basis = result.get("calculation_basis")
    if isinstance(calculation_basis, dict):
        calculation_basis["unknown_problem_policy"] = "server_unclassified"
    return result


def _localized_list(values: Any, *, limit: int = 2) -> dict[str, str]:
    cleaned = [str(value).strip() for value in values or [] if str(value or "").strip()]
    cleaned = list(dict.fromkeys(cleaned))
    visible = cleaned[:limit]
    remainder = max(0, len(cleaned) - len(visible))
    if not visible:
        return {"ko": "", "zh": ""}
    joined = ", ".join(visible)
    return {
        "ko": f"{joined}{f' 외 {remainder}개' if remainder else ''}",
        "zh": f"{joined}{f'等{len(cleaned)}项' if remainder else ''}",
    }


def _metric_impact_text(metric: dict[str, Any]) -> dict[str, str]:
    impact = metric.get("impact_scope") if isinstance(metric.get("impact_scope"), dict) else {}
    machines = _localized_list(impact.get("machine_names"))
    models = _localized_list(impact.get("model_names"))
    parts = _localized_list(impact.get("part_nos"), limit=1)
    group_count = int(impact.get("plan_group_count") or 0)

    ko_values = [value for value in (machines["ko"], models["ko"], parts["ko"]) if value]
    zh_values = [value for value in (machines["zh"], models["zh"], parts["zh"]) if value]
    if not ko_values:
        return {"ko": "연결 계획 없음", "zh": "无关联计划"}
    ko = " / ".join(ko_values)
    zh = " / ".join(zh_values)
    if group_count:
        ko += f" ({group_count}개 계획 그룹)"
        zh += f"（{group_count}个计划组）"
    return {"ko": ko, "zh": zh}


def _metric_label_and_kind(metric: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    label = _metric_template_label(metric)
    metric_key = str(metric.get("metric_key") or "")
    if metric_key.startswith("pair:"):
        return label, {"ko": "문제·위치 결합", "zh": "问题·位置组合"}
    if metric_key.startswith("location:"):
        return label, {"ko": "발생 위치", "zh": "发生位置"}
    return label, {"ko": "문제 유형", "zh": "问题类型"}


def _pct(value: Any) -> str:
    try:
        return f"{float(value):.1f}"
    except (TypeError, ValueError, OverflowError):
        return "-"


def _authoritative_target_headline(source_item: dict[str, Any]) -> dict[str, str]:
    machine = str(source_item.get("machine_name") or "").strip() or "설비 미확인"
    machines_zh = machine if machine != "설비 미확인" else "设备未确认"
    models = _localized_list(source_item.get("model_names"), limit=2)
    parts = _localized_list(source_item.get("part_nos"), limit=1)
    report_count = int(source_item.get("matching_report_count") or 0)
    target_ko = " / ".join(value for value in (machine, models["ko"], parts["ko"]) if value)
    target_zh = " / ".join(value for value in (machines_zh, models["zh"], parts["zh"]) if value)
    return {
        "ko": f"{target_ko}: 연결된 과거 품질 기록 {report_count}건을 생산 전 확인합니다.",
        "zh": f"{target_zh}：生产前确认关联的{report_count}条历史品质记录。",
    }


def _authoritative_target_checkpoints(source_item: dict[str, Any]) -> dict[str, list[str]]:
    headline = _authoritative_target_headline(source_item)
    latest = str(source_item.get("latest_report_dt") or "").strip()
    ko = [headline["ko"]]
    zh = [headline["zh"]]
    if latest:
        ko.append(f"이 계획 대상과 연결된 가장 최근 과거 기록일은 {latest[:10]}입니다.")
        zh.append(f"与该计划对象关联的最近历史记录日期为{latest[:10]}。")
    return {"ko": ko, "zh": zh}


def _authoritative_public_target_headline(
    source_item: dict[str, Any],
    signals: list[dict[str, Any]],
) -> dict[str, str]:
    if not signals:
        return _authoritative_target_headline(source_item)
    primary = signals[0]
    label = _bilingual(primary.get("label"))
    count = int(primary.get("evidence_count") or 0)
    denominator = int(primary.get("denominator") or 0)
    trend = primary.get("trend") if isinstance(primary.get("trend"), dict) else {}
    prefix_ko = "최근 증가 이력" if trend.get("status") == "increase" else "반복 과거 이력"
    prefix_zh = "近期上升记录" if trend.get("status") == "increase" else "重复历史记录"
    machine = str(source_item.get("machine_name") or "").strip() or "설비 미확인"
    machine_zh = machine if machine != "설비 미확인" else "设备未确认"
    models = _localized_list(source_item.get("model_names"), limit=1)
    target_ko = " / ".join(value for value in (machine, models["ko"]) if value)
    target_zh = " / ".join(value for value in (machine_zh, models["zh"]) if value)
    return {
        "ko": f"{target_ko}: {prefix_ko} {label['ko']} {count}/{denominator}건을 우선 확인합니다.",
        "zh": f"{target_zh}：优先确认{prefix_zh}{label['zh']}（{count}/{denominator}条）。",
    }


def _authoritative_public_target_checkpoints(
    source_item: dict[str, Any],
    signals: list[dict[str, Any]],
) -> dict[str, list[str]]:
    result = _authoritative_target_checkpoints(source_item)
    if not signals:
        return result
    primary = signals[0]
    label = _bilingual(primary.get("label"))
    trend = primary.get("trend") if isinstance(primary.get("trend"), dict) else {}
    if trend.get("status") == "increase":
        ko = (
            f"{label['ko']} 기록은 최근 30일 "
            f"{int(trend.get('recent_count') or 0)}/{int(trend.get('recent_denominator') or 0)}건, "
            f"직전 30일 {int(trend.get('previous_count') or 0)}/{int(trend.get('previous_denominator') or 0)}건입니다."
        )
        zh = (
            f"{label['zh']}记录最近30天为"
            f"{int(trend.get('recent_count') or 0)}/{int(trend.get('recent_denominator') or 0)}条，"
            f"此前30天为{int(trend.get('previous_count') or 0)}/{int(trend.get('previous_denominator') or 0)}条。"
        )
    else:
        ko = (
            f"{label['ko']} 과거 기록은 전체 "
            f"{int(primary.get('denominator') or 0)}건 중 "
            f"{int(primary.get('evidence_count') or 0)}건입니다."
        )
        zh = (
            f"{label['zh']}历史记录在全部{int(primary.get('denominator') or 0)}条中为"
            f"{int(primary.get('evidence_count') or 0)}条。"
        )
    return {
        "ko": [ko, *result["ko"]][:3],
        "zh": [zh, *result["zh"]][:3],
    }


def _metric_template_label(metric: dict[str, Any]) -> dict[str, str]:
    if metric.get("classification_basis") == "unclassified_recorded_text_hash":
        return {"ko": "미분류 현상", "zh": "未分类现象"}
    label = _bilingual(metric.get("label"))
    return {
        "ko": label["ko"] or "품질 현상",
        "zh": label["zh"] or "品质现象",
    }


def _authoritative_metric_narrative(
    metric: dict[str, Any],
    *,
    accelerating: bool,
) -> dict[str, str]:
    label, kind = _metric_label_and_kind(metric)
    evidence_count = int(metric.get("evidence_count") or 0)
    denominator = int(metric.get("all_history_denominator") or 0)
    share = _pct(metric.get("all_history_share_pct"))
    latest = str(metric.get("latest_report_dt") or "").strip()[:10] or "-"
    impact = _metric_impact_text(metric)
    if accelerating:
        trend = metric.get("trend") if isinstance(metric.get("trend"), dict) else {}
        recent_count = int(trend.get("recent_count") or 0)
        recent_denominator = int(trend.get("recent_denominator") or 0)
        previous_count = int(trend.get("previous_count") or 0)
        previous_denominator = int(trend.get("previous_denominator") or 0)
        recent_share = _pct(trend.get("recent_share_pct"))
        previous_share = _pct(trend.get("previous_share_pct"))
        count_change = int(trend.get("count_change") or 0)
        share_change = _pct(trend.get("share_change_pp"))
        return {
            "ko": (
                f"최근 증가 {kind['ko']}: {label['ko']} — 최근 30일 "
                f"{recent_count}/{recent_denominator}건({recent_share}%)으로 직전 30일 "
                f"{previous_count}/{previous_denominator}건({previous_share}%)보다 "
                f"보고 빈도가 {count_change}건·{share_change}%p 높습니다. "
                f"현재 계획 영향 범위는 {impact['ko']}입니다."
            ),
            "zh": (
                f"近期上升的{kind['zh']}：{label['zh']}——最近30天为"
                f"{recent_count}/{recent_denominator}条（{recent_share}%），较此前30天的"
                f"{previous_count}/{previous_denominator}条（{previous_share}%）增加"
                f"{count_change}条、{share_change}个百分点。当前计划影响范围：{impact['zh']}。"
            ),
        }
    return {
        "ko": (
            f"반복 {kind['ko']}: {label['ko']} — 연결된 전체 과거 품질 기록 "
            f"{denominator}건 중 {evidence_count}건({share}%)이며, 최근 기록일은 "
            f"{latest}입니다. 현재 계획 영향 범위는 {impact['ko']}입니다."
        ),
        "zh": (
            f"重复{kind['zh']}：{label['zh']}——关联的全部历史品质记录"
            f"{denominator}条中有{evidence_count}条（{share}%），最近记录日期为"
            f"{latest}。当前计划影响范围：{impact['zh']}。"
        ),
    }


def _metric_from_rows(
    rows: list[dict[str, Any]],
    metric_index: dict[str, dict[str, Any]],
    *,
    prefix: str | None = None,
) -> dict[str, Any] | None:
    for row in rows:
        metric_key = str(row.get("metric_key") or "")
        if prefix and not metric_key.startswith(prefix):
            continue
        metric = metric_index.get(metric_key)
        if metric:
            return metric
    return None


def _first_deterministic_metric(
    metrics: dict[str, Any],
    group_name: str,
    *,
    repeated_only: bool = False,
    increasing_only: bool = False,
) -> dict[str, Any] | None:
    for metric in metrics.get(group_name) or []:
        if not isinstance(metric, dict):
            continue
        metric_key = str(metric.get("metric_key") or "")
        if (
            metric_key == "problem:missing"
            or metric_key.startswith("problem:unclassified")
            or metric.get("classification_basis") in {
                "missing_recorded_phenomenon",
                "unclassified_recorded_text_hash",
                "unclassified",
            }
        ):
            continue
        if repeated_only and int(metric.get("evidence_count") or 0) < 2:
            continue
        if increasing_only and (metric.get("trend") or {}).get("status") != "increase":
            continue
        return metric
    return None


def _metric_applies_to_source(
    metric: dict[str, Any],
    source_item: dict[str, Any],
) -> bool:
    impact = metric.get("impact_scope") if isinstance(metric.get("impact_scope"), dict) else {}
    machine = str(source_item.get("machine_name") or "")
    prefix = str(source_item.get("part_prefix") or "")
    return (
        machine in {str(value) for value in impact.get("machine_names") or []}
        and prefix in {str(value) for value in impact.get("part_prefixes") or []}
    )


def _public_metric_signal(metric: dict[str, Any]) -> dict[str, Any]:
    metric_key = str(metric.get("metric_key") or "")
    trend = metric.get("trend") if isinstance(metric.get("trend"), dict) else {}
    dimension = (
        "problem_location_pair"
        if metric_key.startswith("pair:")
        else "problem_type"
    )
    return {
        "metric_key": metric_key,
        "dimension": dimension,
        "label": _metric_template_label(metric),
        "evidence_count": int(metric.get("evidence_count") or 0),
        "denominator": int(metric.get("all_history_denominator") or 0),
        "share_pct": metric.get("all_history_share_pct"),
        "trend": {
            key: trend.get(key)
            for key in (
                "status",
                "reason",
                "recent_count",
                "recent_denominator",
                "recent_share_pct",
                "previous_count",
                "previous_denominator",
                "previous_share_pct",
                "count_change",
                "share_change_pp",
            )
        },
    }


def _authoritative_report_summary(
    metrics: dict[str, Any],
    metric_index: dict[str, dict[str, Any]],
    repeated_rows: list[dict[str, Any]],
    accelerating_rows: list[dict[str, Any]],
    affected_targets: list[dict[str, Any]],
    source_items: dict[str, dict[str, Any]],
) -> dict[str, str]:
    coverage = metrics.get("coverage") if isinstance(metrics.get("coverage"), dict) else {}
    total_reports = int(coverage.get("matched_report_count") or 0)
    if total_reports <= 0:
        return {
            "ko": "현재 생산계획 품번과 연결된 과거 품질 기록이 없어 반복 문제와 최근 증가를 판단하지 않습니다.",
            "zh": "当前生产计划料号没有关联的历史品质记录，因此不判断重复问题与近期上升趋势。",
        }

    problem = _metric_from_rows(repeated_rows, metric_index, prefix="problem:")
    if problem is None:
        problem = _first_deterministic_metric(metrics, "problem_types", repeated_only=True)
    paired = next(
        (
            metric_index.get(str(row.get("metric_key") or ""))
            for row in repeated_rows
            if str(row.get("metric_key") or "").startswith("pair:")
            and metric_index.get(str(row.get("metric_key") or ""))
        ),
        None,
    )
    if paired is None:
        paired = _first_deterministic_metric(
            metrics,
            "problem_location_pairs",
            repeated_only=True,
        )
    increasing = _metric_from_rows(accelerating_rows, metric_index)
    if increasing is None:
        increasing = (
            _first_deterministic_metric(metrics, "problem_types", increasing_only=True)
            or _first_deterministic_metric(
                metrics,
                "problem_location_pairs",
                increasing_only=True,
            )
        )

    if problem:
        problem_label = _metric_template_label(problem)
        problem_count = int(problem.get("evidence_count") or 0)
        problem_ko = f"반복 문제 상위는 {problem_label['ko']} {problem_count}건"
        problem_zh = f"重复问题首位为{problem_label['zh']}（{problem_count}条）"
    else:
        problem_ko = "2건 이상 반복된 문제 유형은 없음"
        problem_zh = "没有记录达到2条以上的重复问题类型"

    if paired:
        paired_label = _metric_template_label(paired)
        paired_count = int(paired.get("evidence_count") or 0)
        paired_ko = f"동일 보고서에서 확인된 문제·위치 결합은 {paired_label['ko']} {paired_count}건"
        paired_zh = f"同一报告中确认的问题·位置组合为{paired_label['zh']}（{paired_count}条）"
    else:
        paired_ko = "반복 기준을 충족한 문제·위치 결합은 없음"
        paired_zh = "没有达到重复标准的问题·位置组合"

    sentences_ko = [
        f"연결된 전체 과거 품질 기록 {total_reports}건 기준, {problem_ko}이고 {paired_ko}입니다."
    ]
    sentences_zh = [
        f"按关联的全部{total_reports}条历史品质记录，{problem_zh}，{paired_zh}。"
    ]
    if increasing:
        label = _metric_template_label(increasing)
        trend = increasing.get("trend") or {}
        sentences_ko.append(
            f"최근 증가 지표는 {label['ko']}이며 최근 30일 "
            f"{int(trend.get('recent_count') or 0)}/{int(trend.get('recent_denominator') or 0)}건, "
            f"직전 30일 {int(trend.get('previous_count') or 0)}/{int(trend.get('previous_denominator') or 0)}건입니다."
        )
        sentences_zh.append(
            f"近期上升指标为{label['zh']}，最近30天为"
            f"{int(trend.get('recent_count') or 0)}/{int(trend.get('recent_denominator') or 0)}条，"
            f"此前30天为{int(trend.get('previous_count') or 0)}/{int(trend.get('previous_denominator') or 0)}条。"
        )
    else:
        sentences_ko.append("최근 30일과 직전 30일 비교에서 증가 기준을 충족한 지표는 없습니다.")
        sentences_zh.append("最近30天与此前30天的比较中，没有指标满足上升判定标准。")

    selected_repeated_metrics: list[dict[str, Any]] = []
    selected_keys: set[str] = set()
    for row in repeated_rows:
        metric_key = str(row.get("metric_key") or "")
        metric = metric_index.get(metric_key)
        if (
            not metric
            or not metric_key.startswith("problem:")
            or metric_key.startswith("problem:unclassified")
            or metric_key == "problem:missing"
            or metric_key in selected_keys
        ):
            continue
        selected_keys.add(metric_key)
        selected_repeated_metrics.append(metric)
        if len(selected_repeated_metrics) >= 3:
            break
    additional_repeated = [
        metric for metric in selected_repeated_metrics
        if not problem or metric.get("metric_key") != problem.get("metric_key")
    ][:2]
    if additional_repeated:
        repeated_ko = ", ".join(
            f"{_metric_template_label(metric)['ko']} {int(metric.get('evidence_count') or 0)}건"
            for metric in additional_repeated
        )
        repeated_zh = "、".join(
            f"{_metric_template_label(metric)['zh']}（{int(metric.get('evidence_count') or 0)}条）"
            for metric in additional_repeated
        )
        sentences_ko.append(f"함께 확인할 반복 유형은 {repeated_ko}입니다.")
        sentences_zh.append(f"同时需确认的重复类型为{repeated_zh}。")

    selected_increases: list[dict[str, Any]] = []
    selected_keys.clear()
    for row in accelerating_rows:
        metric_key = str(row.get("metric_key") or "")
        metric = metric_index.get(metric_key)
        if not metric or metric_key in selected_keys:
            continue
        selected_keys.add(metric_key)
        selected_increases.append(metric)
        if len(selected_increases) >= 3:
            break
    additional_increases = [
        metric for metric in selected_increases
        if not increasing or metric.get("metric_key") != increasing.get("metric_key")
    ][:2]
    if additional_increases:
        increase_ko = ", ".join(
            f"{_metric_template_label(metric)['ko']} "
            f"{int((metric.get('trend') or {}).get('recent_count') or 0)}/"
            f"{int((metric.get('trend') or {}).get('recent_denominator') or 0)}건"
            for metric in additional_increases
        )
        increase_zh = "、".join(
            f"{_metric_template_label(metric)['zh']}"
            f"（{int((metric.get('trend') or {}).get('recent_count') or 0)}/"
            f"{int((metric.get('trend') or {}).get('recent_denominator') or 0)}条）"
            for metric in additional_increases
        )
        sentences_ko.append(f"추가 증가 신호는 {increase_ko}입니다.")
        sentences_zh.append(f"其他上升信号为{increase_zh}。")

    selected_targets: list[dict[str, Any]] = []
    for target in affected_targets:
        selected_target = source_items.get(str(target.get("source_key") or ""))
        if selected_target and selected_target not in selected_targets:
            selected_targets.append(selected_target)
        if len(selected_targets) >= 2:
            break
    if not selected_targets and source_items:
        selected_targets.append(max(
            source_items.values(),
            key=lambda item: int(item.get("matching_report_count") or 0),
        ))
    for selected_target in selected_targets:
        target_text = _authoritative_target_headline(selected_target)
        sentences_ko.append(target_text["ko"])
        sentences_zh.append(target_text["zh"])
    return {"ko": " ".join(sentences_ko), "zh": " ".join(sentences_zh)}


def _authoritative_report_shift_checks(
    metrics: dict[str, Any],
    metric_index: dict[str, dict[str, Any]],
    repeated_rows: list[dict[str, Any]],
    accelerating_rows: list[dict[str, Any]],
    affected_targets: list[dict[str, Any]],
    source_items: dict[str, dict[str, Any]],
) -> dict[str, list[str]]:
    ko: list[str] = []
    zh: list[str] = []
    repeated_problem = _metric_from_rows(repeated_rows, metric_index, prefix="problem:")
    repeated_pair = next(
        (
            metric_index.get(str(row.get("metric_key") or ""))
            for row in repeated_rows
            if str(row.get("metric_key") or "").startswith("pair:")
            and metric_index.get(str(row.get("metric_key") or ""))
        ),
        None,
    )
    if repeated_problem is None:
        repeated_problem = _first_deterministic_metric(metrics, "problem_types", repeated_only=True)
    if repeated_pair is None:
        repeated_pair = _first_deterministic_metric(
            metrics,
            "problem_location_pairs",
            repeated_only=True,
        )
    if repeated_problem:
        label = _metric_template_label(repeated_problem)
        count = int(repeated_problem.get("evidence_count") or 0)
        denominator = int(repeated_problem.get("all_history_denominator") or 0)
        ko.append(f"반복 문제 {label['ko']}의 과거 기록 {count}/{denominator}건을 교대 전 확인하세요.")
        zh.append(f"交接班前确认重复问题{label['zh']}的历史记录{count}/{denominator}条。")
    if repeated_pair:
        label = _metric_template_label(repeated_pair)
        count = int(repeated_pair.get("evidence_count") or 0)
        ko.append(f"동일 보고서에서 확인된 문제·위치 결합 {label['ko']}의 과거 기록 {count}건을 검사 기준과 함께 확인하세요.")
        zh.append(f"请结合检验标准确认同一报告中的问题·位置组合{label['zh']}相关的{count}条历史记录。")
    increasing = _metric_from_rows(accelerating_rows, metric_index)
    if increasing:
        label = _metric_template_label(increasing)
        trend = increasing.get("trend") or {}
        ko.append(
            f"{label['ko']} 보고 빈도는 최근 30일 "
            f"{int(trend.get('recent_count') or 0)}/{int(trend.get('recent_denominator') or 0)}건, "
            f"직전 30일 {int(trend.get('previous_count') or 0)}/{int(trend.get('previous_denominator') or 0)}건이므로 이력 변화를 공유하세요."
        )
        zh.append(
            f"{label['zh']}报告频次最近30天为"
            f"{int(trend.get('recent_count') or 0)}/{int(trend.get('recent_denominator') or 0)}条，"
            f"此前30天为{int(trend.get('previous_count') or 0)}/{int(trend.get('previous_denominator') or 0)}条，请在交接时共享该变化。"
        )

    for target in affected_targets[:1]:
        source_item = source_items.get(str(target.get("source_key") or ""))
        if not source_item:
            continue
        checks = _authoritative_target_checkpoints(source_item)
        ko.extend(checks["ko"][:1])
        zh.extend(checks["zh"][:1])
    if not ko:
        return _authoritative_attention_checkpoints()
    return {"ko": ko[:4], "zh": zh[:4]}


def _candidate_has_unsafe_prose(candidate: dict[str, Any]) -> bool:
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
    report = candidate.get("report")
    if isinstance(report, dict):
        bilingual_values.append(report.get("executive_summary"))
        for group_name in ("repeated_issues", "accelerating_issues"):
            for row in report.get(group_name) or []:
                if isinstance(row, dict):
                    bilingual_values.append(row.get("narrative"))
        for row in report.get("affected_targets") or []:
            if isinstance(row, dict):
                bilingual_values.append(row.get("headline"))
        for group_name in ("shift_checks", "caveats"):
            value = report.get(group_name)
            if isinstance(value, dict):
                checkpoint_values.append(value)
    for value in bilingual_values:
        texts = _bilingual(value)
        if any(
            _contains_unsupported_claim(texts[language], language)
            or _contains_unverified_number(texts[language])
            for language in ("ko", "zh")
        ):
            return True
    for value in checkpoint_values:
        for language in ("ko", "zh"):
            if any(
                _contains_unsupported_claim(text, language)
                or _contains_unverified_number(text)
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
            _contains_unsupported_claim(labels[language], language)
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


def _restore_attention_issue_selections(
    value: Any,
    *,
    metrics: dict[str, Any],
    valid_report_ids: set[int],
    evidence_report_ids: dict[str, set[int]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split v4 issue selections into problem and same-report pair facts.

    The Worker currently returns both metric dimensions in its historical
    ``problem_types`` list.  This server projection keeps the old problem list
    useful while exposing pairs distinctly and restoring every label/count
    from the authoritative metric/evidence input.
    """

    problem_index = {
        str(row.get("metric_key")): row
        for row in metrics.get("problem_types") or []
        if isinstance(row, dict) and row.get("metric_key")
    }
    pair_index = {
        str(row.get("metric_key")): row
        for row in metrics.get("problem_location_pairs") or []
        if isinstance(row, dict)
        and str(row.get("metric_key") or "").startswith("pair:")
        and row.get("dimension") == "problem_location_pair"
        and row.get("classification_basis")
        == "canonical_problem_explicit_location_pair_v1"
        and row.get("pair_basis") == "same_quality_report_id"
    }
    problem_rows: list[dict[str, Any]] = []
    pairs: list[dict[str, Any]] = []
    used_pair_keys: set[str] = set()
    for raw in value if isinstance(value, list) else []:
        if not isinstance(raw, dict):
            continue
        metric_key = str(raw.get("metric_key") or "")
        requested_keys = [
            str(key)
            for key in raw.get("source_evidence_keys") or []
            if str(key) in evidence_report_ids
        ]
        if metric := pair_index.get(metric_key):
            if metric_key in used_pair_keys:
                continue
            allowed_keys = {
                str(key) for key in metric.get("source_evidence_keys") or []
            }
            accepted_keys = list(dict.fromkeys(
                key for key in requested_keys if key in allowed_keys
            ))
            source_ids = sorted({
                report_id
                for key in accepted_keys
                for report_id in evidence_report_ids.get(key, set())
                if report_id in valid_report_ids
            })
            if not accepted_keys or not source_ids:
                continue
            used_pair_keys.add(metric_key)
            problem_label = _bilingual(metric.get("problem_label"))
            location_label = _bilingual(metric.get("location_label"))
            label = _bilingual(metric.get("label"))
            if not all(
                bilingual.get("ko") and bilingual.get("zh")
                for bilingual in (problem_label, location_label, label)
            ):
                continue
            problem_rows.append({
                "label": problem_label,
                "source_evidence_keys": accepted_keys,
            })
            pairs.append({
                "metric_key": metric_key,
                "dimension": "problem_location_pair",
                "label": label,
                "problem_label": problem_label,
                "location_label": location_label,
                "count": len(source_ids),
                "source_evidence_keys": accepted_keys,
                "pair_basis": "same_quality_report_id",
            })
            continue
        if metric_key.startswith("pair:"):
            # Never downgrade an invented or malformed pair into a problem row.
            continue
        if metric := problem_index.get(metric_key):
            allowed_keys = {
                str(key) for key in metric.get("source_evidence_keys") or []
            }
            accepted_keys = list(dict.fromkeys(
                key for key in requested_keys if key in allowed_keys
            ))
            if accepted_keys:
                problem_rows.append({
                    "label": _metric_template_label(metric),
                    "source_evidence_keys": accepted_keys,
                })
            continue
        # Preserve pre-v4/no-key problem classifications for backward
        # compatibility; prompt/version gating prevents them becoming current
        # after the v4 rollout.
        if not metric_key:
            problem_rows.append(raw)
    return problem_rows, pairs


def _restore_page_report_narrative(
    source: dict[str, Any],
    candidate: dict[str, Any],
) -> dict[str, Any] | None:
    raw_report = candidate.get("report")
    if not isinstance(raw_report, dict):
        return None
    metrics = source.get("report_metrics")
    if not isinstance(metrics, dict):
        return None

    metric_index: dict[str, dict[str, Any]] = {}
    # Standalone location coverage rows are deliberately excluded: Qwen may
    # select a problem type or a server-proven same-report problem/location
    # pair, never a location by itself.
    for group_name in ("problem_types", "problem_location_pairs"):
        for metric in metrics.get(group_name) or []:
            if not isinstance(metric, dict) or not metric.get("metric_key"):
                continue
            metric_index[str(metric["metric_key"])] = metric

    def metric_narratives(value: Any, *, accelerating: bool) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        rows = []
        used_keys: set[str] = set()
        for raw in value[:10]:
            if not isinstance(raw, dict):
                continue
            metric_key = str(raw.get("metric_key") or "")
            metric = metric_index.get(metric_key)
            if not metric or metric_key in used_keys:
                continue
            if accelerating:
                if (metric.get("trend") or {}).get("status") != "increase":
                    continue
            elif int(metric.get("evidence_count") or 0) < 2:
                continue
            used_keys.add(metric_key)
            rows.append({
                "metric_key": metric_key,
                "source_evidence_keys": list(metric.get("source_evidence_keys") or []),
                "narrative": _authoritative_metric_narrative(
                    metric,
                    accelerating=accelerating,
                ),
            })
        return rows

    evidence_catalog = {
        str(row.get("evidence_key")): row
        for row in source.get("evidence_catalog") or []
        if isinstance(row, dict) and row.get("evidence_key")
    }
    source_items = {
        str(item.get("source_key")): item
        for item in source.get("items") or []
        if isinstance(item, dict) and item.get("source_key")
    }
    affected_targets = []
    used_source_keys: set[str] = set()
    for raw in raw_report.get("affected_targets") or []:
        if not isinstance(raw, dict):
            continue
        source_key = str(raw.get("source_key") or "")
        source_item = source_items.get(source_key)
        if not source_item or source_key in used_source_keys:
            continue
        evidence = evidence_catalog.get(str(source_item.get("evidence_key") or ""), {})
        valid_keys = {
            str(row.get("evidence_key"))
            for row in evidence.get("phenomena") or []
            if isinstance(row, dict)
            and row.get("evidence_key")
            and row.get("is_missing_text") is not True
        }
        accepted_keys = [
            str(key)
            for key in raw.get("source_evidence_keys") or []
            if str(key) in valid_keys
        ]
        if not accepted_keys:
            continue
        used_source_keys.add(source_key)
        affected_targets.append({
            "source_key": source_key,
            "source_evidence_keys": list(dict.fromkeys(accepted_keys)),
            "headline": _authoritative_target_headline(source_item),
        })

    repeated_issues = metric_narratives(
        raw_report.get("repeated_issues"),
        accelerating=False,
    )
    accelerating_issues = metric_narratives(
        raw_report.get("accelerating_issues"),
        accelerating=True,
    )
    executive_summary = _authoritative_report_summary(
        metrics,
        metric_index,
        repeated_issues,
        accelerating_issues,
        affected_targets,
        source_items,
    )
    return {
        "schema_version": QUALITY_DAILY_NARRATIVE_SCHEMA_VERSION,
        "executive_summary": executive_summary,
        "repeated_issues": repeated_issues,
        "accelerating_issues": accelerating_issues,
        "affected_targets": affected_targets,
        "shift_checks": _authoritative_report_shift_checks(
            metrics,
            metric_index,
            repeated_issues,
            accelerating_issues,
            affected_targets,
            source_items,
        ),
        "caveats": {
            "ko": [
                "과거 보고 기록 빈도 기준이며 현재 상태를 뜻하지 않습니다.",
                "비교 자료가 충분하지 않은 추세는 해석하지 않습니다.",
            ],
            "zh": [
                "仅依据历史报告记录频次，不代表当前状态。",
                "比较资料不足的趋势不作解读。",
            ],
        },
    }


def restore_authoritative_quality_result(job: AiJob, worker_result: Any) -> dict[str, Any]:
    """Discard invented source rows/counts and merge prose onto server evidence."""

    source = job.input_payload if isinstance(job.input_payload, dict) else {}
    candidate = worker_result if isinstance(worker_result, dict) else {}
    scope = job.scope if isinstance(job.scope, dict) else {}
    source_contract_mismatch = (
        not source.get("source_plan_hash")
        or not source.get("source_evidence_hash")
        or scope.get("source_plan_hash") != source.get("source_plan_hash")
        or scope.get("source_evidence_hash") != source.get("source_evidence_hash")
    )
    generation_source = str(candidate.get("source") or "")[:64]
    server_safety_rejected = _candidate_has_unsafe_prose(candidate)
    llm_fallback = (
        candidate.get("llm_fallback") is True
        or generation_source != "local_llm_rewrite"
        or server_safety_rejected
        or source_contract_mismatch
    )
    llm_fallback_code = str(candidate.get("llm_fallback_code") or "")[:64]
    if llm_fallback and not llm_fallback_code:
        llm_fallback_code = (
            "server_safety_rejected"
            if server_safety_rejected
            else (
                "source_hash_mismatch"
                if source_contract_mismatch
                else "unverified_generation_source"
            )
        )
    worker_rows = [
        item
        for item in candidate.get("attention_items") or []
        if isinstance(item, dict) and item.get("source_key")
    ]
    worker_items = {str(item.get("source_key")): item for item in worker_rows}
    worker_priority = {
        str(item.get("source_key")): rank
        for rank, item in enumerate(worker_rows, start=1)
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
        attention_problem_rows, attention_pairs = _restore_attention_issue_selections(
            worker_item.get("problem_types"),
            metrics=(
                source.get("report_metrics")
                if isinstance(source.get("report_metrics"), dict)
                else {}
            ),
            valid_report_ids=report_ids,
            evidence_report_ids=evidence_report_ids,
        )
        restored_items.append({
            "source_key": source_key,
            "priority_rank": worker_priority.get(source_key),
            "machine_name": source_item.get("machine_name") or "",
            "machine_number": source_item.get("machine_number"),
            "sequence": source_item.get("sequence"),
            "part_prefix": source_item.get("part_prefix") or "",
            "part_nos": list(source_item.get("part_nos") or []),
            "model_names": list(source_item.get("model_names") or []),
            "matching_report_count": int(source_item.get("matching_report_count") or 0),
            "latest_report_dt": source_item.get("latest_report_dt"),
            "match_basis": source_item.get("match_basis"),
            "headline": _authoritative_attention_headline(),
            "checkpoints": _authoritative_attention_checkpoints(),
            "problem_types": _classified_groups(
                attention_problem_rows,
                report_ids,
                evidence_report_ids,
                missing_evidence_keys,
                QUALITY_UNKNOWN_PROBLEM_TYPE,
            ),
            "problem_location_pairs": attention_pairs,
            # The overview keeps its existing list-shaped contract, but
            # standalone/unknown locations are no longer AI insights.  Paired
            # issue/location signals live exclusively in report_metrics and
            # the authenticated daily report.
            "locations": [],
            "evidence_report_ids": sorted(report_ids),
        })

    restored_items.sort(key=lambda item: (
        item.get("priority_rank") if item.get("priority_rank") is not None else 999999,
        item.get("machine_number") if item.get("machine_number") is not None else 999999,
        item.get("source_key") or "",
    ))

    return {
        "schema_version": source.get("schema_version") or QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "business_date": source.get("date"),
        "source_plan_hash": source.get("source_plan_hash"),
        "source_evidence_hash": source.get("source_evidence_hash"),
        "source_evidence_last_changed_at": source.get(
            "source_evidence_last_changed_at"
        ),
        "model_id": source.get("model_id") or QUALITY_DAILY_MODEL_ID,
        "selection_contract_version": (
            source.get("selection_contract_version")
            or QUALITY_DAILY_EXPECTED_PROMPT_VERSION
        ),
        "summary": _authoritative_summary(source),
        "report": _restore_page_report_narrative(source, candidate),
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


def _public_completed_result(
    job: AiJob,
    target_date: date,
    source_plan_hash: str,
    source_evidence_hash: str,
) -> dict[str, Any]:
    result = job.result_payload if isinstance(job.result_payload, dict) else {}
    generation_source = str(result.get("generation_source") or "")[:64]
    source_hash_mismatch = (
        result.get("source_plan_hash") != source_plan_hash
        or result.get("source_evidence_hash") != source_evidence_hash
    )
    prompt_mismatch = job.prompt_version != QUALITY_DAILY_EXPECTED_PROMPT_VERSION
    llm_fallback = (
        result.get("llm_fallback") is True
        or generation_source != "local_llm_rewrite"
        or source_hash_mismatch
        or prompt_mismatch
    )
    public_items = []
    valid_source_keys = {
        str(item.get("source_key"))
        for item in (
            job.input_payload.get("items")
            if isinstance(job.input_payload, dict)
            else []
        ) or []
        if isinstance(item, dict) and item.get("source_key")
    }
    for item in result.get("attention_items") or []:
        if (
            not isinstance(item, dict)
            or str(item.get("source_key") or "") not in valid_source_keys
        ):
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
                "problem_location_pairs",
                "locations",
            )
        })
        public_items[-1]["headline"] = _authoritative_attention_headline()
        public_items[-1]["checkpoints"] = _authoritative_attention_checkpoints()
        for group_key in ("problem_types",):
            public_items[-1][group_key] = [
                {
                    "label": group.get("label"),
                    "count": group.get("count"),
                    "source_evidence_keys": list(group.get("source_evidence_keys") or []),
                }
                for group in item.get(group_key) or []
                if isinstance(group, dict)
            ]
        public_items[-1]["locations"] = []
        public_items[-1]["problem_location_pairs"] = [
            {
                "label": pair.get("label"),
                "problem_label": pair.get("problem_label"),
                "location_label": pair.get("location_label"),
                "count": int(pair.get("count") or 0),
            }
            for pair in item.get("problem_location_pairs") or []
            if isinstance(pair, dict)
            and int(pair.get("count") or 0) > 0
        ]
    return {
        "status": "ready",
        "business_date": target_date.isoformat(),
        "source_plan_hash": source_plan_hash,
        "source_evidence_hash": source_evidence_hash,
        "source_evidence_last_changed_at": result.get(
            "source_evidence_last_changed_at"
        ),
        "generated_at": result.get("generated_at"),
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "model_id": QUALITY_DAILY_MODEL_ID,
        "schema_version": result.get("schema_version") or QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "summary": _authoritative_summary(
            job.input_payload if isinstance(job.input_payload, dict) else {}
        ),
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
            or ("source_hash_mismatch" if source_hash_mismatch else "")
            or ("outdated_prompt_version" if prompt_mismatch else "")
            or ("unverified_generation_source" if llm_fallback else "")
        )[:64],
    }


def quality_summary_for_overview(target_date: date) -> dict[str, Any]:
    """Return only an exact-plan completed summary, plus explicit fallback state."""

    plan_state = quality_attention_plan_snapshot(target_date)
    source_plan_hash = plan_state.get("source_plan_hash")
    evidence_state = (
        quality_attention_evidence_snapshot(target_date)
        if source_plan_hash
        else {}
    )
    source_evidence_hash = evidence_state.get("source_evidence_hash")
    base = {
        "status": "unavailable",
        "business_date": target_date.isoformat(),
        "source_plan_hash": source_plan_hash,
        "source_evidence_hash": source_evidence_hash,
        "source_evidence_last_changed_at": evidence_state.get(
            "source_evidence_last_changed_at"
        ),
        "generated_at": None,
        "completed_at": None,
        "model_id": QUALITY_DAILY_MODEL_ID,
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
    if not source_plan_hash or not source_evidence_hash:
        return base

    jobs = AiJob.objects.filter(
        job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
        scope__mode=QUALITY_DAILY_MODE,
        scope__trigger=QUALITY_DAILY_TRIGGER,
        scope__date=target_date.isoformat(),
    )
    exact = jobs.filter(scope__source_plan_hash=source_plan_hash)
    exact = exact.filter(scope__source_evidence_hash=source_evidence_hash)
    completed = exact.filter(status=AiJob.STATUS_COMPLETED).order_by("-completed_at", "-id").first()
    if completed:
        public = _public_completed_result(
            completed,
            target_date,
            source_plan_hash,
            source_evidence_hash,
        )
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
    completed_jobs = jobs.filter(status=AiJob.STATUS_COMPLETED)
    if completed_jobs.filter(scope__source_plan_hash=source_plan_hash).exists():
        return {**base, "status": "stale", "reason": "evidence_changed"}
    if completed_jobs.exists():
        return {**base, "status": "stale", "reason": "plan_changed"}
    return base


def quality_daily_report_for_page(
    target_date: date,
    *,
    deterministic_report: dict[str, Any] | None = None,
    source_plan_hash: str | None = None,
    source_plan_last_changed_at: str | None = None,
    source_evidence_hash: str | None = None,
    source_evidence_last_changed_at: str | None = None,
) -> dict[str, Any]:
    """Return the authenticated daily-page report contract.

    Numeric analysis is always the caller-supplied deterministic report built
    from the current plan and quality history.  Completed Qwen output is
    projected only as bilingual narrative and priority order, and only when it
    matches both the exact current plan and relevant-quality-evidence
    fingerprints.
    """

    if source_plan_hash is None:
        source_plan_hash = quality_attention_plan_snapshot(target_date).get("source_plan_hash")
    if source_plan_hash and source_evidence_hash is None:
        evidence_state = quality_attention_evidence_snapshot(target_date)
        source_evidence_hash = evidence_state.get("source_evidence_hash")
        source_evidence_last_changed_at = evidence_state.get(
            "source_evidence_last_changed_at"
        )
    deterministic_internal = dict(deterministic_report or {})
    deterministic = _public_deterministic_report(deterministic_internal)
    source_revision = _compact_public_revision(
        source_plan_hash,
        source_evidence_hash,
    )
    base = {
        "schema_version": QUALITY_DAILY_PAGE_REPORT_SCHEMA_VERSION,
        "contract_version": QUALITY_DAILY_PUBLIC_CONTRACT_VERSION,
        "status": "unavailable",
        "reason": "no_plan" if not source_plan_hash else "not_generated",
        "business_date": target_date.isoformat(),
        "source_revision": source_revision,
        "source_plan_last_changed_at": source_plan_last_changed_at,
        "source_evidence_last_changed_at": source_evidence_last_changed_at,
        "generated_at": None,
        "completed_at": None,
        "model_id": QUALITY_DAILY_MODEL_ID,
        "ai_schema_version": QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "deterministic_schema_version": (
            deterministic.get("schema_version") or QUALITY_DAILY_REPORT_SCHEMA_VERSION
        ),
        "disclaimer": dict(QUALITY_DAILY_DISCLAIMER),
        "narrative": None,
        "deterministic": deterministic,
        "generation_source": None,
        "llm_fallback": False,
        "llm_fallback_code": "",
        "data_policy": {
            "numbers_and_trends_are_backend_authoritative": True,
            "llm_role": "grounded_key_selection_and_priority_order_only",
            "public_prose_source": "server_owned_templates",
            "stale_narrative_exposed": False,
            "raw_report_ids_exposed": False,
            "images_exposed_in_report": False,
            "current_defect_claim_allowed": False,
            "root_cause_claim_allowed": False,
        },
    }
    if not source_plan_hash or not source_evidence_hash:
        return base

    try:
        jobs = AiJob.objects.filter(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope__mode=QUALITY_DAILY_MODE,
            scope__trigger=QUALITY_DAILY_TRIGGER,
            scope__date=target_date.isoformat(),
        )
        exact = jobs.filter(
            scope__source_plan_hash=source_plan_hash,
            scope__source_evidence_hash=source_evidence_hash,
        )
        completed = exact.filter(status=AiJob.STATUS_COMPLETED).order_by(
            "-completed_at", "-id"
        ).first()
        if completed:
            result = completed.result_payload if isinstance(completed.result_payload, dict) else {}
            generation_source = str(result.get("generation_source") or "")[:64]
            source_hash_mismatch = (
                result.get("source_plan_hash") != source_plan_hash
                or result.get("source_evidence_hash") != source_evidence_hash
            )
            prompt_mismatch = (
                completed.prompt_version != QUALITY_DAILY_EXPECTED_PROMPT_VERSION
            )
            llm_fallback = (
                result.get("llm_fallback") is True
                or generation_source != "local_llm_rewrite"
                or source_hash_mismatch
                or prompt_mismatch
            )
            if llm_fallback:
                return {
                    **base,
                    "reason": "llm_fallback",
                    "completed_at": completed.completed_at.isoformat() if completed.completed_at else None,
                    "generation_source": generation_source or "unverified",
                    "llm_fallback": True,
                    "llm_fallback_code": str(
                        result.get("llm_fallback_code")
                        or ("source_hash_mismatch" if source_hash_mismatch else "")
                        or ("outdated_prompt_version" if prompt_mismatch else "")
                        or "unverified_generation_source"
                    )[:64],
                }

            stored_report = result.get("report") if isinstance(result.get("report"), dict) else {}
            if stored_report.get("schema_version") != QUALITY_DAILY_NARRATIVE_SCHEMA_VERSION:
                return {
                    **base,
                    "reason": "not_generated",
                    "completed_at": completed.completed_at.isoformat() if completed.completed_at else None,
                    "generation_source": generation_source or "unverified",
                }
            verified_stored_report = _restore_page_report_narrative(
                completed.input_payload
                if isinstance(completed.input_payload, dict)
                else {},
                {"report": stored_report},
            )
            if verified_stored_report is None:
                return {**base, "reason": "not_generated"}
            stored_report = verified_stored_report

            priorities = []
            valid_priority_sources = {
                str(item.get("source_key"))
                for item in (
                    completed.input_payload.get("items")
                    if isinstance(completed.input_payload, dict)
                    else []
                ) or []
                if isinstance(item, dict) and item.get("source_key")
            }
            for fallback_rank, item in enumerate(result.get("attention_items") or [], start=1):
                if (
                    not isinstance(item, dict)
                    or str(item.get("source_key") or "") not in valid_priority_sources
                ):
                    continue
                rank = item.get("priority_rank")
                if not isinstance(rank, int) or rank < 1:
                    rank = fallback_rank
                priorities.append({
                    "priority_rank": rank,
                    "source_key": str(item.get("source_key") or "")[:200],
                    "headline": _authoritative_attention_headline(),
                    "checkpoints": _authoritative_attention_checkpoints(),
                })
            priorities.sort(key=lambda item: (item["priority_rank"], item["source_key"]))
            metric_index = {
                str(metric.get("metric_key")): metric
                for group_name in ("problem_types", "problem_location_pairs")
                for metric in deterministic_internal.get(group_name) or []
                if isinstance(metric, dict) and metric.get("metric_key")
            }

            def public_metric_narratives(group_name: str, *, accelerating: bool) -> list[dict[str, Any]]:
                rows = []
                used: set[str] = set()
                for row in stored_report.get(group_name) or []:
                    if not isinstance(row, dict):
                        continue
                    metric_key = str(row.get("metric_key") or "")
                    metric = metric_index.get(metric_key)
                    if not metric or metric_key in used:
                        continue
                    if accelerating:
                        if (metric.get("trend") or {}).get("status") != "increase":
                            continue
                    elif int(metric.get("evidence_count") or 0) < 2:
                        continue
                    used.add(metric_key)
                    rows.append({
                        "metric_key": metric_key,
                        "source_evidence_keys": list(metric.get("source_evidence_keys") or []),
                        "narrative": _authoritative_metric_narrative(
                            metric,
                            accelerating=accelerating,
                        ),
                    })
                return rows

            input_payload = (
                completed.input_payload
                if isinstance(completed.input_payload, dict)
                else {}
            )
            source_items = {
                str(item.get("source_key")): item
                for item in input_payload.get("items") or []
                if isinstance(item, dict) and item.get("source_key")
            }
            repeated_issues = public_metric_narratives(
                "repeated_issues",
                accelerating=False,
            )
            accelerating_issues = public_metric_narratives(
                "accelerating_issues",
                accelerating=True,
            )
            internal_affected_targets = [
                row
                for row in stored_report.get("affected_targets") or []
                if isinstance(row, dict)
                and source_items.get(str(row.get("source_key") or ""))
            ]
            # Worker v4's final report selector is the authoritative AI target
            # ordering.  Keep only exact restored source keys, then append any
            # remaining verified attention targets in their deterministic
            # fallback order.  Public ranks are recomputed so they cannot be
            # forged by either payload.
            fallback_priority_keys = [
                str(priority.get("source_key") or "")
                for priority in priorities
                if source_items.get(str(priority.get("source_key") or ""))
            ]
            selector_priority_keys = [
                str(target.get("source_key") or "")
                for target in internal_affected_targets
                if source_items.get(str(target.get("source_key") or ""))
            ]
            ordered_priority_keys: list[str] = []
            for source_key in selector_priority_keys + fallback_priority_keys:
                if source_key and source_key not in ordered_priority_keys:
                    ordered_priority_keys.append(source_key)
            priorities = [
                {"priority_rank": rank, "source_key": source_key}
                for rank, source_key in enumerate(ordered_priority_keys, start=1)
            ]
            summary = _authoritative_report_summary(
                deterministic_internal,
                metric_index,
                repeated_issues,
                accelerating_issues,
                internal_affected_targets,
                source_items,
            )

            def public_target(source_key: str) -> dict[str, Any] | None:
                source_item = source_items.get(source_key)
                if not source_item:
                    return None
                target_ref = hashlib.sha256(
                    f"{source_revision or ''}\0{source_key}".encode("utf-8")
                ).hexdigest()[:10]
                signals: list[dict[str, Any]] = []
                used_metric_keys: set[str] = set()

                def add_signal(metric: dict[str, Any] | None) -> None:
                    if not metric or not _metric_applies_to_source(metric, source_item):
                        return
                    metric_key = str(metric.get("metric_key") or "")
                    if not metric_key or metric_key in used_metric_keys:
                        return
                    used_metric_keys.add(metric_key)
                    signals.append(_public_metric_signal(metric))

                # The worker controls selection/order only.  Every public
                # signal is restored from the deterministic metric index and
                # must overlap this exact machine/prefix plan target.
                for selected in accelerating_issues + repeated_issues:
                    add_signal(metric_index.get(str(selected.get("metric_key") or "")))
                    if len(signals) >= 3 or {
                        row["dimension"] for row in signals
                    } == {"problem_type", "problem_location_pair"}:
                        break
                if not any(row["dimension"] == "problem_type" for row in signals):
                    for metric in deterministic_internal.get("problem_types") or []:
                        if isinstance(metric, dict) and int(metric.get("evidence_count") or 0) >= 2:
                            add_signal(metric)
                            if any(row["dimension"] == "problem_type" for row in signals):
                                break
                if not any(
                    row["dimension"] == "problem_location_pair"
                    for row in signals
                ):
                    for metric in deterministic_internal.get("problem_location_pairs") or []:
                        if (
                            isinstance(metric, dict)
                            and int(metric.get("evidence_count") or 0) >= 2
                        ):
                            add_signal(metric)
                            if any(
                                row["dimension"] == "problem_location_pair"
                                for row in signals
                            ):
                                break

                signals.sort(key=lambda signal: (
                    0 if signal["metric_key"] == (
                        str((accelerating_issues + repeated_issues)[0].get("metric_key") or "")
                        if accelerating_issues + repeated_issues
                        else ""
                    ) else 1,
                    0 if signal["dimension"] == "problem_type" else 1,
                    -int(signal.get("evidence_count") or 0),
                    signal["metric_key"],
                ))

                return {
                    "target_ref": target_ref,
                    "machine_name": source_item.get("machine_name") or "",
                    "machine_number": source_item.get("machine_number"),
                    "model_names": list(source_item.get("model_names") or []),
                    "part_nos": list(source_item.get("part_nos") or []),
                    "primary_metric_key": (
                        signals[0]["metric_key"] if signals else None
                    ),
                    "signals": signals[:3],
                    "headline": _authoritative_public_target_headline(
                        source_item,
                        signals,
                    ),
                }

            public_priorities = []
            for priority in priorities:
                projected = public_target(str(priority.get("source_key") or ""))
                if not projected:
                    continue
                source_item = source_items[str(priority["source_key"])]
                public_priorities.append({
                    "priority_rank": priority["priority_rank"],
                    **projected,
                    "checkpoints": _authoritative_public_target_checkpoints(
                        source_item,
                        list(projected.get("signals") or []),
                    ),
                })
            public_affected_targets = []
            for row in internal_affected_targets:
                projected = public_target(str(row.get("source_key") or ""))
                if projected:
                    public_affected_targets.append(projected)

            shift_checks = _authoritative_report_shift_checks(
                deterministic_internal,
                metric_index,
                repeated_issues,
                accelerating_issues,
                internal_affected_targets,
                source_items,
            )
            return {
                **base,
                "status": "ready",
                "reason": None,
                "generated_at": result.get("generated_at"),
                "completed_at": completed.completed_at.isoformat() if completed.completed_at else None,
                "disclaimer": dict(result.get("disclaimer") or QUALITY_DAILY_DISCLAIMER),
                "narrative": {
                    "schema_version": QUALITY_DAILY_NARRATIVE_SCHEMA_VERSION,
                    "summary": summary,
                    "executive_summary": summary,
                    "priorities": public_priorities,
                    "repeated_issues": [
                        {
                            "metric_key": row["metric_key"],
                            "narrative": row["narrative"],
                        }
                        for row in repeated_issues
                    ],
                    "accelerating_issues": [
                        {
                            "metric_key": row["metric_key"],
                            "narrative": row["narrative"],
                        }
                        for row in accelerating_issues
                    ],
                    "affected_targets": public_affected_targets,
                    "shift_checks": shift_checks,
                    "caveats": {
                        "ko": [
                            "과거 보고 기록 빈도 기준이며 현재 상태를 뜻하지 않습니다.",
                            "비교 자료가 충분하지 않은 추세는 해석하지 않습니다.",
                        ],
                        "zh": [
                            "仅依据历史报告记录频次，不代表当前状态。",
                            "比较资料不足的趋势不作解读。",
                        ],
                    },
                },
                "generation_source": generation_source,
            }
        if exact.filter(status__in=QUALITY_DAILY_ACTIVE_STATUSES).exists():
            return {**base, "status": "pending", "reason": "generation_pending"}
        if exact.filter(status=AiJob.STATUS_FAILED).exists():
            return {**base, "reason": "generation_failed"}
        completed_jobs = jobs.filter(status=AiJob.STATUS_COMPLETED)
        if completed_jobs.filter(scope__source_plan_hash=source_plan_hash).exists():
            return {**base, "status": "stale", "reason": "evidence_changed"}
        if completed_jobs.exists():
            return {**base, "status": "stale", "reason": "plan_changed"}
        return base
    except DatabaseError:
        return {**base, "reason": "store_unavailable"}
