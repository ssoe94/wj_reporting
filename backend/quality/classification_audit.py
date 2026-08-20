"""Deterministic orchestration for report-level Qwen classification audits.

No source report or PartSpec is changed by an AI job.  The job stores a
reviewable suggestion tied to the exact report revision and exact full Part
No.  A human may later approve a category decision or explicitly create a new
versioned PartSpec colour.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from datetime import date, timedelta
import hashlib
import json
import re
from typing import Any, Iterable
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import F, Value
from django.db.models.functions import Replace, Upper
from django.utils import timezone

from ai_core.models import AiJob
from ai_core.quality_report_audit import (
    QUALITY_BODY_COLOR_KEYS,
    QUALITY_BODY_COLOR_LABELS,
    QUALITY_REPORT_AUDIT_MODE,
    QUALITY_REPORT_AUDIT_PROMPT_VERSION,
    QUALITY_REPORT_AUDIT_RESULT_SCHEMA_VERSION,
    QUALITY_REPORT_AUDIT_SOURCE,
    QUALITY_REPORT_AUDIT_TRIGGER,
    QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
)
from injection.models import PartSpec

from .daily_attention import _canonical_problem_types, normalize_part_no
from .injection_terminology import (
    INJECTION_DEFECT_OBSERVED_TERMS,
    INJECTION_DEFECT_TERMS,
    INJECTION_TERMINOLOGY_VERSION,
)
from .models import QualityReport


SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
QUALITY_REPORT_AUDIT_SCAN_LIMIT = 5
QUALITY_REPORT_AUDIT_SCAN_WINDOW = 100
QUALITY_REPORT_AUDIT_MAX_MANUAL_BATCH = 200
QUALITY_REPORT_AUDIT_MAX_PAGE_SIZE = 50
QUALITY_REPORT_AUDIT_REVIEW_ACTIONS = frozenset({
    "accepted",
    "overridden",
    "rejected",
})
COLOR_REVIEW_REASON_CODES = frozenset({
    "master_color_missing",
    "master_color_mismatch",
    "visual_color_uncertain",
    "no_usable_image",
    "partial_image_processing",
    "unversioned_image_reference",
})
MASTER_COLOR_VALUES = {
    "white": "WHITE",
    "black": "BLACK",
    "gray": "GRAY",
    "silver": "SILVER",
    "beige": "BEIGE",
    "transparent": "TRANSPARENT",
    "blue": "BLUE",
    "red": "RED",
}


def _normalized_part_spec_queryset(normalized_part_nos: Iterable[str]):
    values = sorted({str(value) for value in normalized_part_nos if str(value)})
    if not values:
        return PartSpec.objects.none()
    normalized_expression = Upper(
        Replace(
            Replace(
                Replace(
                    Replace(F("part_no"), Value(" "), Value("")),
                    Value("\t"),
                    Value(""),
                ),
                Value("\n"),
                Value(""),
            ),
            Value("\r"),
            Value(""),
        )
    )
    return PartSpec.objects.annotate(
        normalized_part_no=normalized_expression,
    ).filter(normalized_part_no__in=values)


def normalize_master_color(value: Any) -> str | None:
    normalized = re.sub(r"[\s_\-/]+", "", str(value or "")).casefold()
    if not normalized:
        return None
    rules = (
        ("white", ("white", "wh", "백색", "흰색", "白色", "白")),
        ("black", ("black", "bk", "검정", "흑색", "黑色", "黑")),
        ("gray", ("gray", "grey", "gy", "회색", "灰色", "灰")),
        ("silver", ("silver", "sv", "은색", "银色", "銀色")),
        ("beige", ("beige", "베이지", "米色")),
        ("transparent", ("transparent", "clear", "투명", "透明")),
        ("blue", ("blue", "파랑", "청색", "蓝色", "藍色")),
        ("red", ("red", "빨강", "적색", "红色", "紅色")),
    )
    for key, aliases in rules:
        if normalized in {re.sub(r"[\s_\-/]+", "", alias).casefold() for alias in aliases}:
            return key
    return None


def taxonomy_candidates() -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for key, label, aliases in INJECTION_DEFECT_TERMS:
        observed_rules = INJECTION_DEFECT_OBSERVED_TERMS.get(key, ())
        if observed_rules:
            for observed_key, observed_label, observed_aliases in observed_rules:
                candidates.append({
                    "key": observed_key,
                    "parent_key": key,
                    "label": deepcopy(observed_label),
                    "source_terms": list(dict.fromkeys(observed_aliases))[:16],
                })
            continue
        candidates.append({
            "key": key,
            "parent_key": None,
            "label": deepcopy(label),
            "source_terms": list(dict.fromkeys(aliases))[:16],
        })
    return candidates


def _report_date(report: QualityReport) -> date:
    value = report.report_dt
    if timezone.is_naive(value):
        value = timezone.make_aware(value, SHANGHAI_TZ)
    return value.astimezone(SHANGHAI_TZ).date()


def _part_spec_lookup(reports: Iterable[QualityReport]) -> dict[str, list[PartSpec]]:
    normalized_part_nos: set[str] = set()
    for report in reports:
        normalized = normalize_part_no(report.part_no)
        if normalized:
            normalized_part_nos.add(normalized)
    if not normalized_part_nos:
        return {}
    rows = _normalized_part_spec_queryset(normalized_part_nos).order_by(
        "part_no", "-valid_from", "-id"
    )
    result: dict[str, list[PartSpec]] = defaultdict(list)
    for row in rows:
        result[normalize_part_no(row.part_no)].append(row)
    return dict(result)


def _select_part_spec(
    report: QualityReport,
    specs_by_part: dict[str, list[PartSpec]] | None = None,
) -> dict[str, Any]:
    normalized = normalize_part_no(report.part_no)
    if not normalized:
        return {
            "id": None,
            "color_raw": "",
            "color_key": None,
            "valid_from": None,
            "model_code": "",
            "match_basis": "report_part_no_missing",
        }
    if specs_by_part is None:
        candidates = list(
            _normalized_part_spec_queryset({normalized})
            .order_by("-valid_from", "-id")
        )
    else:
        candidates = list(specs_by_part.get(normalized, []))
    candidates = [
        row for row in candidates if normalize_part_no(row.part_no) == normalized
    ]
    report_date = _report_date(report)
    effective = next((row for row in candidates if row.valid_from <= report_date), None)
    selected = effective or (candidates[0] if candidates else None)
    if selected is None:
        return {
            "id": None,
            "color_raw": "",
            "color_key": None,
            "valid_from": None,
            "model_code": "",
            "match_basis": "no_exact_part_spec",
        }
    return {
        "id": selected.pk,
        "color_raw": selected.color or "",
        "color_key": normalize_master_color(selected.color),
        "valid_from": selected.valid_from.isoformat(),
        "model_code": selected.model_code or "",
        "match_basis": (
            "exact_part_no_effective_on_report_date"
            if effective is not None
            else "exact_part_no_latest_not_yet_effective"
        ),
    }


def _immutable_cloudinary_reference(url: str) -> bool:
    parsed = urlparse(str(url or ""))
    return bool(
        parsed.scheme == "https"
        and (parsed.hostname or "").lower() == "res.cloudinary.com"
        and re.search(r"/v\d+/", parsed.path)
    )


def _report_image_refs(report: QualityReport) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index in range(1, 6):
        slot = f"image{index}"
        url = str(getattr(report, slot, None) or "").strip()
        if url:
            result.append({
                "slot": slot,
                "url": url,
                "immutable_reference": _immutable_cloudinary_reference(url),
                "reference_sha256": hashlib.sha256(url.encode("utf-8")).hexdigest(),
            })
    return result


def build_quality_report_audit_input(
    report: QualityReport,
    *,
    specs_by_part: dict[str, list[PartSpec]] | None = None,
) -> tuple[dict[str, Any], str]:
    part_spec = _select_part_spec(report, specs_by_part)
    deterministic = _canonical_problem_types(report.phenomenon)
    raw_context = {
        "phenomenon": str(report.phenomenon or ""),
        "disposition": str(report.disposition or ""),
        "action_result": str(report.action_result or ""),
    }
    raw_text_sha256 = hashlib.sha256(
        json.dumps(raw_context, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    payload = {
        "source": QUALITY_REPORT_AUDIT_SOURCE,
        "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
        "audit_contract": {
            "model_id": "qwen38",
            "prompt_version": QUALITY_REPORT_AUDIT_PROMPT_VERSION,
            "worker_schema_version": QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION,
            "result_schema_version": QUALITY_REPORT_AUDIT_RESULT_SCHEMA_VERSION,
        },
        "report": {
            "id": report.pk,
            "report_dt": report.report_dt.isoformat(),
            "updated_at": report.updated_at.isoformat(),
            "section": report.section,
            "model": report.model or "",
            "part_no": normalize_part_no(report.part_no),
            "phenomenon": report.phenomenon or "",
            "disposition": report.disposition or "",
            "action_result": report.action_result or "",
            "image_refs": _report_image_refs(report),
        },
        "raw_text_sha256": raw_text_sha256,
        "part_spec": part_spec,
        "deterministic_classification": deterministic,
        "taxonomy_candidates": taxonomy_candidates(),
    }
    report_revision_material = {
        "schema": QUALITY_REPORT_AUDIT_SOURCE,
        "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
        "report": payload["report"],
        "raw_text_sha256": raw_text_sha256,
    }
    report_source_revision = hashlib.sha256(
        json.dumps(
            report_revision_material,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    payload["report_source_revision"] = report_source_revision
    revision_material = {
        "schema": QUALITY_REPORT_AUDIT_SOURCE,
        "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
        "audit_contract": payload["audit_contract"],
        "report": payload["report"],
        "raw_text_sha256": raw_text_sha256,
        "part_spec": part_spec,
    }
    source_revision = hashlib.sha256(
        json.dumps(
            revision_material,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    return payload, source_revision


def enqueue_quality_report_audit(
    report: QualityReport,
    *,
    created_by: Any = None,
    specs_by_part: dict[str, list[PartSpec]] | None = None,
) -> tuple[AiJob, bool]:
    input_payload, source_revision = build_quality_report_audit_input(
        report,
        specs_by_part=specs_by_part,
    )
    scope = {
        "mode": QUALITY_REPORT_AUDIT_MODE,
        "trigger": QUALITY_REPORT_AUDIT_TRIGGER,
        "report_id": report.pk,
        "source_revision": source_revision,
        "report_source_revision": input_payload["report_source_revision"],
        "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
        "model_id": "qwen38",
    }
    existing = (
        AiJob.objects.filter(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope__mode=QUALITY_REPORT_AUDIT_MODE,
            scope__trigger=QUALITY_REPORT_AUDIT_TRIGGER,
            scope__report_id=report.pk,
            scope__source_revision=source_revision,
        )
        .order_by("-id")
        .first()
    )
    if existing is not None:
        result = existing.result_payload if isinstance(existing.result_payload, dict) else {}
        retryable = (
            existing.status in {AiJob.STATUS_FAILED}
            or (
                existing.status == AiJob.STATUS_COMPLETED
                and result.get("available") is not True
            )
        )
        retryable = bool(
            retryable
            and existing.updated_at <= timezone.now() - timedelta(minutes=5)
        )
        if not retryable:
            return existing, False
    job = AiJob.objects.create(
        job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
        status=AiJob.STATUS_PENDING,
        scope=scope,
        input_payload=input_payload,
        created_by=created_by,
    )
    return job, True


def enqueue_stale_quality_report_audits(
    *,
    limit: int = QUALITY_REPORT_AUDIT_SCAN_LIMIT,
    report_ids: Iterable[int] | None = None,
    created_by: Any = None,
    bounded_scan: bool = False,
) -> dict[str, Any]:
    limit = max(1, min(int(limit or 1), QUALITY_REPORT_AUDIT_MAX_MANUAL_BATCH))
    queryset = QualityReport.objects.order_by("-report_dt", "-id")
    if report_ids is not None:
        ids = [value for value in report_ids if type(value) is int and value > 0]
        queryset = queryset.filter(pk__in=ids)
    total_report_count = queryset.count() if bounded_scan and report_ids is None else None
    if bounded_scan and report_ids is None and total_report_count:
        page_count = max(
            1,
            (total_report_count + QUALITY_REPORT_AUDIT_SCAN_WINDOW - 1)
            // QUALITY_REPORT_AUDIT_SCAN_WINDOW,
        )
        page_index = int(timezone.now().timestamp() // 60) % page_count
        start = page_index * QUALITY_REPORT_AUDIT_SCAN_WINDOW
        reports = list(queryset[start:start + QUALITY_REPORT_AUDIT_SCAN_WINDOW])
    else:
        reports = list(queryset)
    if total_report_count is None:
        total_report_count = len(reports)
    specs_by_part = _part_spec_lookup(reports)
    snapshots = {
        report.pk: build_quality_report_audit_input(
            report,
            specs_by_part=specs_by_part,
        )
        for report in reports
    }
    jobs_by_report: dict[int, list[AiJob]] = defaultdict(list)
    if reports:
        jobs = AiJob.objects.filter(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            scope__mode=QUALITY_REPORT_AUDIT_MODE,
            scope__trigger=QUALITY_REPORT_AUDIT_TRIGGER,
            scope__report_id__in=[report.pk for report in reports],
            scope__source_revision__in=[
                snapshot[1] for snapshot in snapshots.values()
            ],
        ).order_by("-id")
        for job in jobs:
            scope = job.scope if isinstance(job.scope, dict) else {}
            report_id = scope.get("report_id")
            if type(report_id) is int:
                jobs_by_report[report_id].append(job)
    created_jobs: list[AiJob] = []
    examined = 0
    eligible_count = 0
    for report in reports:
        examined += 1
        input_payload, source_revision = snapshots[report.pk]
        existing = next((
            job
            for job in jobs_by_report.get(report.pk, [])
            if isinstance(job.scope, dict)
            and job.scope.get("source_revision") == source_revision
        ), None)
        if existing is not None:
            result = (
                existing.result_payload
                if isinstance(existing.result_payload, dict)
                else {}
            )
            retryable = (
                existing.status == AiJob.STATUS_FAILED
                or (
                    existing.status == AiJob.STATUS_COMPLETED
                    and result.get("available") is not True
                )
            ) and existing.updated_at <= timezone.now() - timedelta(minutes=5)
            if not retryable:
                continue
        eligible_count += 1
        if len(created_jobs) >= limit:
            continue
        scope = {
            "mode": QUALITY_REPORT_AUDIT_MODE,
            "trigger": QUALITY_REPORT_AUDIT_TRIGGER,
            "report_id": report.pk,
            "source_revision": source_revision,
            "report_source_revision": input_payload["report_source_revision"],
            "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
            "model_id": "qwen38",
        }
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
            status=AiJob.STATUS_PENDING,
            scope=scope,
            input_payload=input_payload,
            created_by=created_by,
        )
        created_jobs.append(job)
    return {
        "created_count": len(created_jobs),
        "created_job_ids": [job.pk for job in created_jobs],
        "examined_count": examined,
        "total_report_count": total_report_count,
        "eligible_count": eligible_count,
        "remaining_count": max(0, eligible_count - len(created_jobs)),
    }


def _latest_jobs_by_current_revision(
    reports: list[QualityReport],
    specs_by_part: dict[str, list[PartSpec]],
) -> tuple[dict[int, tuple[dict[str, Any], str]], dict[int, AiJob]]:
    snapshots: dict[int, tuple[dict[str, Any], str]] = {}
    for report in reports:
        snapshots[report.pk] = build_quality_report_audit_input(
            report,
            specs_by_part=specs_by_part,
        )
    jobs = AiJob.objects.filter(
        job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
        scope__mode=QUALITY_REPORT_AUDIT_MODE,
        scope__trigger=QUALITY_REPORT_AUDIT_TRIGGER,
        scope__report_id__in=[report.pk for report in reports],
        scope__source_revision__in=[
            source_revision for _payload, source_revision in snapshots.values()
        ],
    ).order_by("-id")
    current: dict[int, AiJob] = {}
    for job in jobs:
        scope = job.scope if isinstance(job.scope, dict) else {}
        report_id = scope.get("report_id")
        if type(report_id) is not int or report_id in current:
            continue
        snapshot = snapshots.get(report_id)
        if snapshot and scope.get("source_revision") == snapshot[1]:
            current[report_id] = job
    return snapshots, current


def _job_queue_status(job: AiJob | None) -> str:
    if job is None:
        return "unprocessed"
    if job.status != AiJob.STATUS_COMPLETED:
        return job.status
    result = job.result_payload if isinstance(job.result_payload, dict) else {}
    if result.get("available") is True and result.get("review_required") is True:
        return "needs_review"
    review = result.get("review") if isinstance(result.get("review"), dict) else None
    if review and review.get("status") in QUALITY_REPORT_AUDIT_REVIEW_ACTIONS:
        return "reviewed"
    if result.get("available") is not True:
        return "failed"
    return "needs_review" if result.get("review_required") else "matched"


def _exact_part_consensus(
    current_jobs: dict[int, AiJob],
) -> dict[str, dict[str, Any]]:
    counts_by_part: dict[str, Counter[str]] = defaultdict(Counter)
    report_ids_by_part: dict[str, set[int]] = defaultdict(set)
    reviewed_counts_by_part: Counter[str] = Counter()
    for report_id, job in current_jobs.items():
        if job.status != AiJob.STATUS_COMPLETED:
            continue
        result = job.result_payload if isinstance(job.result_payload, dict) else {}
        if result.get("available") is not True:
            continue
        review = result.get("review") if isinstance(result.get("review"), dict) else {}
        if review.get("status") not in {"accepted", "overridden"}:
            continue
        part_no = normalize_part_no(review.get("exact_part_no"))
        if not part_no:
            continue
        reviewed_color = str(review.get("product_color_key") or "")
        if reviewed_color in {"", "other", "undetermined"}:
            continue
        color_key = reviewed_color
        reviewed_counts_by_part[part_no] += 1
        counts_by_part[part_no][color_key] += 1
        report_ids_by_part[part_no].add(report_id)
    result: dict[str, dict[str, Any]] = {}
    for part_no, counts in counts_by_part.items():
        total = sum(counts.values())
        top_key, top_count = counts.most_common(1)[0]
        result[part_no] = {
            "exact_part_no": part_no,
            "report_count": len(report_ids_by_part[part_no]),
            "assessable_photo_report_count": total,
            "reviewed_report_count": reviewed_counts_by_part[part_no],
            "qwen_high_confidence_report_count": 0,
            "dominant_color_key": top_key,
            "dominant_color_label": deepcopy(QUALITY_BODY_COLOR_LABELS[top_key]),
            "agreement_pct": round(top_count / total * 100, 1) if total else None,
            "color_counts": dict(counts),
            "match_basis": "normalized_full_part_no_only",
            "confidence_basis": "human_reviewed_only",
        }
    return result


def _reviewed_classifications(category_keys: list[str]) -> list[dict[str, Any]]:
    candidates = taxonomy_candidates()
    candidate_by_key = {str(row["key"]): row for row in candidates}
    parent_labels = {
        key: deepcopy(label)
        for key, label, _aliases in INJECTION_DEFECT_TERMS
    }
    ordered_keys = [
        str(row["key"])
        for row in candidates
        if str(row["key"]) in set(category_keys)
    ]
    rows: list[dict[str, Any]] = []
    parent_rows: dict[str, dict[str, Any]] = {}
    for key in ordered_keys:
        candidate = candidate_by_key[key]
        parent_key = str(candidate.get("parent_key") or "")
        if parent_key:
            parent = parent_rows.get(parent_key)
            if parent is None:
                parent = {
                    "key": parent_key,
                    "metric_key": f"problem:{parent_key}",
                    "label": deepcopy(parent_labels[parent_key]),
                    "classification_basis": "canonical_alias_v1",
                    "classification_source": "human_reviewed_qwen_audit_v1",
                    "observed_terms": [],
                }
                parent_rows[parent_key] = parent
                rows.append(parent)
            parent["observed_terms"].append({
                "key": key,
                "label": deepcopy(candidate["label"]),
                "classification_basis": "human_reviewed_observed_term_v1",
            })
            continue
        rows.append({
            "key": key,
            "metric_key": f"problem:{key}",
            "label": deepcopy(candidate["label"]),
            "classification_basis": "canonical_alias_v1",
            "classification_source": "human_reviewed_qwen_audit_v1",
        })
    return rows


def approved_quality_report_classifications(
    reports: Iterable[QualityReport],
) -> tuple[dict[int, list[dict[str, Any]]], list[dict[str, Any]]]:
    """Return only human-approved decisions matching the current report revision."""

    report_rows = list({report.pk: report for report in reports}.values())
    if not report_rows:
        return {}, []
    specs_by_part = _part_spec_lookup(report_rows)
    report_revisions = {
        report.pk: build_quality_report_audit_input(
            report,
            specs_by_part=specs_by_part,
        )[0]["report_source_revision"]
        for report in report_rows
    }
    jobs = AiJob.objects.filter(
        job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
        status=AiJob.STATUS_COMPLETED,
        scope__mode=QUALITY_REPORT_AUDIT_MODE,
        scope__trigger=QUALITY_REPORT_AUDIT_TRIGGER,
        scope__taxonomy_version=INJECTION_TERMINOLOGY_VERSION,
        scope__report_id__in=list(report_revisions),
    ).order_by("-id")
    overrides: dict[int, list[dict[str, Any]]] = {}
    revision_rows: list[dict[str, Any]] = []
    for job in jobs:
        scope = job.scope if isinstance(job.scope, dict) else {}
        report_id = scope.get("report_id")
        if type(report_id) is not int or report_id in overrides:
            continue
        result = job.result_payload if isinstance(job.result_payload, dict) else {}
        review = result.get("review") if isinstance(result.get("review"), dict) else {}
        if review.get("status") not in {"accepted", "overridden"}:
            continue
        if review.get("report_source_revision") != report_revisions.get(report_id):
            continue
        category_keys = review.get("category_keys")
        if not isinstance(category_keys, list):
            continue
        classifications = _reviewed_classifications([
            str(value) for value in category_keys if str(value)
        ])
        if not classifications:
            continue
        overrides[report_id] = classifications
        revision_rows.append({
            "report_id": report_id,
            "report_source_revision": report_revisions[report_id],
            "category_keys": sorted(str(value) for value in category_keys if str(value)),
            "review_status": review.get("status"),
            "reviewed_at": review.get("reviewed_at"),
            "job_id": job.pk,
        })
    revision_rows.sort(key=lambda row: row["report_id"])
    return overrides, revision_rows


def quality_report_audit_queue(
    *,
    page: int = 1,
    page_size: int = 20,
    status_filter: str = "attention",
    report_id: int | None = None,
    search: str = "",
) -> dict[str, Any]:
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 20), QUALITY_REPORT_AUDIT_MAX_PAGE_SIZE))
    queryset = QualityReport.objects.order_by("-report_dt", "-id")
    if report_id is not None:
        queryset = queryset.filter(pk=report_id)
    reports = list(queryset)
    specs_by_part = _part_spec_lookup(reports)
    snapshots, current_jobs = _latest_jobs_by_current_revision(reports, specs_by_part)
    consensus = _exact_part_consensus(current_jobs)
    search_value = str(search or "").strip().casefold()

    def matches_search(row: dict[str, Any]) -> bool:
        if not search_value:
            return True
        report = row["report"]
        values: list[Any] = [
            report.get("part_no"), report.get("model"), report.get("section"),
            report.get("phenomenon"), report.get("disposition"),
            report.get("action_result"), row.get("queue_status"),
            (row.get("part_spec") or {}).get("color_raw"),
        ]
        for term in row.get("deterministic_classification") or []:
            if not isinstance(term, dict):
                continue
            label = term.get("label") if isinstance(term.get("label"), dict) else {}
            values.extend([term.get("key"), *label.values()])
            for observed in term.get("observed_terms") or []:
                if isinstance(observed, dict):
                    observed_label = (
                        observed.get("label")
                        if isinstance(observed.get("label"), dict)
                        else {}
                    )
                    values.extend([
                        observed.get("key"),
                        *observed_label.values(),
                    ])
        result = row.get("result") if isinstance(row.get("result"), dict) else {}
        qwen = (
            result.get("qwen_classification")
            if isinstance(result.get("qwen_classification"), dict)
            else {}
        )
        for selected in qwen.get("candidate_selections") or []:
            if isinstance(selected, dict):
                selected_label = (
                    selected.get("label")
                    if isinstance(selected.get("label"), dict)
                    else {}
                )
                values.extend([
                    selected.get("key"),
                    *selected_label.values(),
                ])
        suggestion = (
            result.get("product_color_suggestion")
            if isinstance(result.get("product_color_suggestion"), dict)
            else {}
        )
        suggestion_label = (
            suggestion.get("suggested_color_label")
            if isinstance(suggestion.get("suggested_color_label"), dict)
            else {}
        )
        values.extend([
            suggestion.get("suggested_color_key"),
            *suggestion_label.values(),
            *(result.get("review_reason_codes") or []),
        ])
        review = result.get("review") if isinstance(result.get("review"), dict) else {}
        for category_key in review.get("category_keys") or []:
            candidate = next((
                candidate_row
                for candidate_row in row.get("taxonomy_candidates") or []
                if isinstance(candidate_row, dict)
                and candidate_row.get("key") == category_key
            ), None)
            candidate_label = (
                candidate.get("label")
                if isinstance(candidate, dict)
                and isinstance(candidate.get("label"), dict)
                else {}
            )
            values.extend([category_key, *candidate_label.values()])
        reviewed_color = str(review.get("product_color_key") or "")
        reviewed_color_label = QUALITY_BODY_COLOR_LABELS.get(reviewed_color, {})
        values.extend([reviewed_color, *reviewed_color_label.values()])
        return search_value in " ".join(str(value or "") for value in values).casefold()

    stats = Counter()
    rows: list[dict[str, Any]] = []
    for report in reports:
        input_payload, source_revision = snapshots[report.pk]
        job = current_jobs.get(report.pk)
        queue_status = _job_queue_status(job)
        stats[queue_status] += 1
        stats["total"] += 1
        if input_payload["report"]["image_refs"]:
            stats["with_images"] += 1
        if status_filter == "attention" and queue_status in {"matched", "reviewed"}:
            continue
        if status_filter not in {"", "all", "attention"} and queue_status != status_filter:
            continue
        result = (
            deepcopy(job.result_payload)
            if job is not None and isinstance(job.result_payload, dict)
            else None
        )
        row = {
            "report": input_payload["report"],
            "source_revision": source_revision,
            "deterministic_classification": input_payload["deterministic_classification"],
            "taxonomy_candidates": [
                {
                    "key": candidate.get("key"),
                    "parent_key": candidate.get("parent_key"),
                    "label": deepcopy(candidate.get("label") or {}),
                }
                for candidate in input_payload["taxonomy_candidates"]
                if isinstance(candidate, dict)
            ],
            "part_spec": input_payload["part_spec"],
            "queue_status": queue_status,
            "job": ({
                "id": job.pk,
                "status": job.status,
                "model_name": job.model_name,
                "prompt_version": job.prompt_version,
                "created_at": job.created_at.isoformat(),
                "completed_at": job.completed_at.isoformat() if job.completed_at else None,
                "error_message": job.error_message,
            } if job is not None else None),
            "result": result,
            "exact_part_consensus": consensus.get(
                normalize_part_no(input_payload["report"]["part_no"])
            ),
        }
        if matches_search(row):
            rows.append(row)
    total_filtered = len(rows)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "count": total_filtered,
        "page": page,
        "page_size": page_size,
        "next_page": page + 1 if end < total_filtered else None,
        "previous_page": page - 1 if page > 1 else None,
        "stats": dict(stats),
        "results": rows[start:end],
        "taxonomy_version": INJECTION_TERMINOLOGY_VERSION,
        "color_match_policy": "normalized_full_part_no_only",
    }


def review_quality_report_audit(
    job_id: int,
    *,
    user: Any,
    action: str,
    category_keys: list[str],
    product_color_key: str | None,
    note: str = "",
) -> AiJob:
    action = str(action or "").strip()
    if action not in QUALITY_REPORT_AUDIT_REVIEW_ACTIONS:
        raise ValueError("Unsupported review action.")
    with transaction.atomic():
        job = AiJob.objects.select_for_update().get(pk=job_id)
        scope = job.scope if isinstance(job.scope, dict) else {}
        if (
            job.job_type != AiJob.JOB_TYPE_QUALITY_IMAGE
            or scope.get("mode") != QUALITY_REPORT_AUDIT_MODE
            or job.status != AiJob.STATUS_COMPLETED
        ):
            raise ValueError("The selected AI job cannot be reviewed.")
        report = QualityReport.objects.get(pk=scope.get("report_id"))
        _payload, current_revision = build_quality_report_audit_input(report)
        if current_revision != scope.get("source_revision"):
            raise RuntimeError("stale_revision")
        input_payload = job.input_payload if isinstance(job.input_payload, dict) else {}
        candidates = input_payload.get("taxonomy_candidates") or []
        allowed_keys = {
            str(row.get("key") or "")
            for row in candidates if isinstance(row, dict)
        }
        cleaned_keys = list(dict.fromkeys(str(key) for key in category_keys if str(key)))
        if any(key not in allowed_keys for key in cleaned_keys):
            raise ValueError("A selected category is not part of the current taxonomy.")
        if action != "rejected" and not cleaned_keys:
            raise ValueError("At least one category is required for this review action.")
        color_key = str(product_color_key or "").strip().lower() or None
        if color_key is not None and color_key not in QUALITY_BODY_COLOR_KEYS:
            raise ValueError("Unsupported product colour.")
        if color_key not in {None, "undetermined"}:
            image_refs = (
                input_payload.get("report", {}).get("image_refs")
                if isinstance(input_payload.get("report"), dict)
                else []
            )
            if (
                not image_refs
                or any(
                    not isinstance(row, dict)
                    or row.get("immutable_reference") is not True
                    for row in image_refs
                )
            ):
                raise ValueError(
                    "A concrete product colour requires versioned report photos."
                )
        reviewed_at = timezone.now().isoformat()
        review = {
            "status": action,
            "category_keys": cleaned_keys,
            "product_color_key": color_key,
            "product_color_label": (
                deepcopy(QUALITY_BODY_COLOR_LABELS[color_key]) if color_key else None
            ),
            "exact_part_no": normalize_part_no(report.part_no),
            "match_basis": "normalized_full_part_no_only",
            "note": str(note or "").strip()[:500],
            "reviewed_by": getattr(user, "username", "") or str(getattr(user, "pk", "")),
            "reviewed_by_id": getattr(user, "pk", None),
            "reviewed_at": reviewed_at,
            "source_revision": current_revision,
            "report_source_revision": str(
                input_payload.get("report_source_revision") or ""
            ),
        }
        result = dict(job.result_payload or {})
        history = list(result.get("review_history") or [])
        history.append(review)
        result["review"] = review
        result["review_history"] = history
        existing_reasons = [
            str(code) for code in result.get("review_reason_codes") or []
            if str(code)
        ]
        unresolved_reasons: list[str] = []
        if (
            action == "rejected"
            and isinstance(result.get("qwen_classification"), dict)
            and result["qwen_classification"].get("needs_new_category") is True
        ):
            unresolved_reasons.append("needs_new_category")
        if color_key is None:
            unresolved_reasons.extend(
                code for code in existing_reasons
                if code in COLOR_REVIEW_REASON_CODES
            )
        unresolved_reasons = list(dict.fromkeys(unresolved_reasons))
        review["unresolved_reason_codes"] = unresolved_reasons
        result["review"] = review
        result["review_history"][-1] = review
        result["review_required"] = bool(unresolved_reasons)
        job.result_payload = result
        job.save(update_fields=["result_payload", "updated_at"])
        return job


def apply_approved_part_color(
    job_id: int,
    *,
    color_key: str,
    valid_from: date,
    user: Any = None,
) -> tuple[PartSpec, bool]:
    color_key = str(color_key or "").strip().lower()
    if color_key not in MASTER_COLOR_VALUES:
        raise ValueError("Only a concrete reviewed product colour can be applied.")
    today = timezone.now().astimezone(SHANGHAI_TZ).date()
    if valid_from > today:
        raise ValueError("The effective date cannot be in the future.")
    with transaction.atomic():
        job = AiJob.objects.select_for_update().get(pk=job_id)
        scope = job.scope if isinstance(job.scope, dict) else {}
        result = job.result_payload if isinstance(job.result_payload, dict) else {}
        review = result.get("review") if isinstance(result.get("review"), dict) else {}
        if review.get("status") not in {"accepted", "overridden"}:
            raise ValueError("Approve the report colour before applying it to the master.")
        if review.get("product_color_key") != color_key:
            raise ValueError("The requested colour does not match the reviewed colour.")
        report = QualityReport.objects.select_for_update().get(pk=scope.get("report_id"))
        _payload, current_revision = build_quality_report_audit_input(report)
        if current_revision != scope.get("source_revision"):
            raise RuntimeError("stale_revision")
        exact_part_no = normalize_part_no(report.part_no)
        if not exact_part_no:
            raise ValueError("An exact Part No. is required.")
        exact_specs = _normalized_part_spec_queryset({exact_part_no})
        existing = exact_specs.filter(valid_from=valid_from).order_by("id").first()
        color_value = MASTER_COLOR_VALUES[color_key]
        if existing is not None:
            if normalize_master_color(existing.color) == color_key:
                return existing, False
            raise RuntimeError("part_spec_version_conflict")
        effective_basis = exact_specs.filter(valid_from__lte=valid_from).order_by(
            "-valid_from", "-id"
        ).first()
        clone_fields = (
            "description", "mold_type", "resin_type", "resin_code",
            "net_weight_g", "sr_weight_g", "tonnage", "cycle_time_sec",
            "efficiency_rate", "cavity", "resin_loss_pct", "defect_rate_pct",
        )
        values = {
            field: (
                getattr(effective_basis, field)
                if effective_basis is not None
                else None
            )
            for field in clone_fields
        }
        for optional_text in ("description", "mold_type", "resin_type", "resin_code"):
            values[optional_text] = values[optional_text] or ""
        part_spec = PartSpec.objects.create(
            part_no=exact_part_no,
            model_code=(
                effective_basis.model_code
                if effective_basis is not None
                else report.model
            ) or "",
            color=color_value,
            valid_from=valid_from,
            **values,
        )
        result = dict(job.result_payload or {})
        result["master_color_application"] = {
            "part_spec_id": part_spec.pk,
            "exact_part_no": exact_part_no,
            "color_key": color_key,
            "color_value": color_value,
            "valid_from": valid_from.isoformat(),
            "created": True,
            "applied_at": timezone.now().isoformat(),
            "applied_by": (
                getattr(user, "username", "")
                or str(getattr(user, "pk", ""))
            ),
            "applied_by_id": getattr(user, "pk", None),
            "basis_part_spec_id": (
                effective_basis.pk if effective_basis is not None else None
            ),
        }
        job.result_payload = result
        job.save(update_fields=["result_payload", "updated_at"])
        return part_spec, True
