"""Shared deterministic source for the daily quality-attention page and AI job.

The production plan and all matching historical quality reports are joined by
the page's established normalized nine-character part-number prefix.  Counts,
dates and source report identifiers are calculated here; the local LLM is only
allowed to classify and rewrite this verified evidence.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from typing import Any, Iterable

from django.db.models import Max

from production.models import ProductionPlan, ProductionPlanChangeLog

from .models import QualityReport


QUALITY_ATTENTION_MATCH_BASIS = "part_prefix_9"
QUALITY_ATTENTION_HISTORY_WINDOW = "all"
QUALITY_ATTENTION_AI_SCHEMA_VERSION = "quality-daily-attention-ai.v1"


def normalize_part_no(part_no: Any) -> str:
    return re.sub(r"\s+", "", str(part_no or "").upper())


def part_prefix(part_no: Any) -> str:
    return normalize_part_no(part_no)[:9]


def extract_machine_number(machine_name: Any) -> int | None:
    value = str(machine_name or "")
    match = re.search(r"(\d+)\s*호기", value)
    if match:
        return int(match.group(1))
    match = re.search(r"-(\d+)\s*$", value)
    return int(match.group(1)) if match else None


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _rounded_quantity(value: Any) -> int:
    try:
        return int(round(float(value or 0)))
    except (TypeError, ValueError, OverflowError):
        return 0


def _canonical_quantity(value: Any) -> str:
    try:
        number = Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        return "0"
    if not number.is_finite():
        return "0"
    rendered = format(number.normalize(), "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


def _plan_rows(target_date: date) -> list[dict[str, Any]]:
    return list(
        ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type="injection",
            planned_quantity__gt=0,
        )
        .order_by("machine_name", "sequence", "id")
        .values(
            "machine_name",
            "model_name",
            "part_no",
            "planned_quantity",
            "sequence",
            "lot_no",
        )
    )


def _canonical_plan_rows(plan_rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    canonical = []
    for row in plan_rows:
        canonical.append({
            "machine_name": _clean_text(row.get("machine_name")),
            "model_name": _clean_text(row.get("model_name")),
            "part_no": normalize_part_no(row.get("part_no")),
            "planned_quantity": _canonical_quantity(row.get("planned_quantity")),
            "sequence": row.get("sequence"),
            "lot_no": _clean_text(row.get("lot_no")),
        })
    return canonical


def quality_attention_plan_hash(plan_rows: Iterable[dict[str, Any]]) -> str:
    encoded = json.dumps(
        _canonical_plan_rows(plan_rows),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def quality_attention_plan_snapshot(target_date: date) -> dict[str, Any]:
    """Return the cheap plan-only state used by schedulers and public boards."""

    plan_rows = _plan_rows(target_date)
    valid_groups = {
        (_clean_text(row.get("machine_name")), part_prefix(row.get("part_no")))
        for row in plan_rows
        if _clean_text(row.get("machine_name")) and part_prefix(row.get("part_no"))
    }
    latest_change = latest_injection_plan_change_at(target_date)
    return {
        "date": target_date.isoformat(),
        "source_plan_hash": quality_attention_plan_hash(plan_rows) if valid_groups else None,
        "source_plan_last_changed_at": latest_change.isoformat() if latest_change else None,
        "plan_group_count": len(valid_groups),
    }


def latest_injection_plan_change_at(target_date: date) -> datetime | None:
    plan_updated = (
        ProductionPlan.objects.filter(plan_date=target_date, plan_type="injection")
        .aggregate(latest=Max("updated_at"))["latest"]
    )
    log_created = (
        ProductionPlanChangeLog.objects.filter(plan_date=target_date, plan_type="injection")
        .aggregate(latest=Max("created_at"))["latest"]
    )
    values = [value for value in (plan_updated, log_created) if value is not None]
    return max(values) if values else None


def _report_groups(prefixes: set[str], *, include_images: bool) -> dict[str, list[QualityReport]]:
    grouped: dict[str, list[QualityReport]] = defaultdict(list)
    if not prefixes:
        return grouped

    report_fields = [
        "id",
        "report_dt",
        "section",
        "model",
        "part_no",
        "judgement",
        "defect_rate",
        "phenomenon",
        "disposition",
        "action_result",
    ]
    if include_images:
        report_fields.extend(("image1", "image2", "image3"))
    reports = (
        QualityReport.objects.exclude(part_no="")
        .order_by("-report_dt", "-id")
        .only(*report_fields)
    )
    for report in reports.iterator():
        prefix = part_prefix(report.part_no)
        if prefix in prefixes:
            grouped[prefix].append(report)
    return grouped


def build_daily_quality_attention(
    target_date: date,
    *,
    include_images: bool = True,
) -> dict[str, Any]:
    """Return the source contract used by ``/quality/daily-attention``.

    There is deliberately no quality-history date filter.  The date applies
    only to the injection production plan whose parts select relevant history.
    """

    plan_rows = _plan_rows(target_date)
    source_plan_hash = quality_attention_plan_hash(plan_rows) if plan_rows else None
    prefixes = {
        prefix
        for prefix in (part_prefix(row.get("part_no")) for row in plan_rows)
        if prefix
    }
    report_groups = _report_groups(prefixes, include_images=include_images)

    grouped_plan_rows: dict[tuple[str, str], dict[str, Any]] = {}
    for row in plan_rows:
        machine_name = _clean_text(row.get("machine_name"))
        normalized_part_no = normalize_part_no(row.get("part_no"))
        prefix = part_prefix(normalized_part_no)
        if not machine_name or not prefix:
            continue

        group = grouped_plan_rows.setdefault(
            (machine_name, prefix),
            {
                "machine_name": machine_name,
                "machine_number": extract_machine_number(machine_name),
                "sequence": row.get("sequence"),
                "part_prefix": prefix,
                "part_nos": [],
                "model_names": [],
                "lot_nos": [],
                "planned_quantity": 0,
                "plan_row_count": 0,
            },
        )
        row_sequence = row.get("sequence")
        current_sequence = group.get("sequence")
        if row_sequence is not None:
            group["sequence"] = (
                row_sequence if current_sequence is None else min(current_sequence, row_sequence)
            )
        if normalized_part_no and normalized_part_no not in group["part_nos"]:
            group["part_nos"].append(normalized_part_no)
        model_name = _clean_text(row.get("model_name"))
        if model_name and model_name not in group["model_names"]:
            group["model_names"].append(model_name)
        lot_no = _clean_text(row.get("lot_no"))
        if lot_no and lot_no not in group["lot_nos"]:
            group["lot_nos"].append(lot_no)
        group["planned_quantity"] += _rounded_quantity(row.get("planned_quantity"))
        group["plan_row_count"] += 1

    items: list[dict[str, Any]] = []
    without_history = 0
    matching_report_ids: set[int] = set()
    for group in grouped_plan_rows.values():
        matched_reports = report_groups.get(group["part_prefix"], [])
        reports_data = []
        for report in matched_reports:
            report_data = {
                "id": report.id,
                "report_dt": report.report_dt.isoformat(),
                "section": report.section,
                "model": report.model or "",
                "part_no": report.part_no or "",
                "judgement": report.judgement or "",
                "defect_rate": report.defect_rate or "",
                "phenomenon": report.phenomenon or "",
                "disposition": report.disposition or "",
                "action_result": report.action_result or "",
                "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
            }
            if include_images:
                report_data["images"] = [
                    image
                    for image in (report.image1, report.image2, report.image3)
                    if image
                ]
            reports_data.append(report_data)

        top_phenomena = Counter(
            _clean_text(report.phenomenon)
            for report in matched_reports
            if _clean_text(report.phenomenon)
        ).most_common(3)
        if not matched_reports:
            without_history += 1
        matching_report_ids.update(report.id for report in matched_reports)
        items.append({
            **group,
            "source_key": f"{group['machine_name']}|{group['part_prefix']}",
            "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
            "matching_report_count": len(matched_reports),
            "latest_report_dt": reports_data[0]["report_dt"] if reports_data else None,
            "top_phenomena": [
                {"phenomenon": phenomenon, "count": count}
                for phenomenon, count in top_phenomena
            ],
            "reports": reports_data,
        })

    items.sort(key=lambda item: (
        item.get("machine_number") or 999999,
        item.get("machine_name") or "",
        item.get("sequence") if item.get("sequence") is not None else 999999,
        item.get("part_prefix") or "",
    ))
    latest_change = latest_injection_plan_change_at(target_date)
    return {
        "date": target_date.isoformat(),
        "history_window": QUALITY_ATTENTION_HISTORY_WINDOW,
        "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
        "source_plan_hash": source_plan_hash,
        "source_plan_last_changed_at": latest_change.isoformat() if latest_change else None,
        "total_plan_count": len(items),
        # A shared prefix can be planned on multiple machines.  Per-target
        # counts may repeat, while the board-level total counts each report once.
        "total_matching_reports": len(matching_report_ids),
        "without_history_count": without_history,
        "items": items,
    }


def _aggregate_report_text(
    reports: list[dict[str, Any]],
    field: str,
    *,
    part_prefix_value: str,
    include_missing: bool = False,
) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for report in reports:
        text = _clean_text(report.get(field))
        report_id = report.get("id")
        report_dt = report.get("report_dt")
        if not isinstance(report_id, int):
            continue
        if not text:
            if not include_missing:
                continue
            text = "[NO_PHENOMENON_RECORDED]"
        group = groups.setdefault(text, {"text": text, "report_ids": [], "report_dates": []})
        group["report_ids"].append(report_id)
        if report_dt:
            group["report_dates"].append(report_dt)
    result = []
    for group in groups.values():
        report_ids = list(dict.fromkeys(group["report_ids"]))
        report_dates = sorted(set(group["report_dates"]), reverse=True)
        digest = hashlib.sha256(f"{field}\0{group['text']}".encode("utf-8")).hexdigest()[:12]
        result.append({
            "evidence_key": f"{part_prefix_value}:{field}:{digest}",
            "text": group["text"],
            "is_missing_text": group["text"] == "[NO_PHENOMENON_RECORDED]",
            "count": len(report_ids),
            "report_ids": report_ids,
            "report_dates": report_dates,
            "latest_report_dt": report_dates[0] if report_dates else None,
        })
    return sorted(result, key=lambda item: (-item["count"], item["text"]))


def build_daily_quality_attention_ai_input(
    target_date: date,
    *,
    model_id: str,
) -> dict[str, Any]:
    """Build a compact all-history, count-authoritative bilingual LLM input."""

    source = build_daily_quality_attention(target_date, include_images=False)
    items = []
    evidence_catalog: dict[str, dict[str, Any]] = {}
    for item in source["items"]:
        reports = item.get("reports") or []
        evidence_key = f"prefix:{item['part_prefix']}"
        if evidence_key not in evidence_catalog:
            evidence_catalog[evidence_key] = {
                "evidence_key": evidence_key,
                "part_prefix": item["part_prefix"],
                "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
                "matching_report_count": item["matching_report_count"],
                "latest_report_dt": item["latest_report_dt"],
                "phenomena": _aggregate_report_text(
                    reports,
                    "phenomenon",
                    part_prefix_value=item["part_prefix"],
                    include_missing=True,
                ),
                "dispositions": _aggregate_report_text(
                    reports,
                    "disposition",
                    part_prefix_value=item["part_prefix"],
                ),
                "action_results": _aggregate_report_text(
                    reports,
                    "action_result",
                    part_prefix_value=item["part_prefix"],
                ),
                "report_refs": [
                    {
                        "report_id": report["id"],
                        "report_dt": report["report_dt"],
                        "part_no": report["part_no"],
                        "model": report["model"],
                        "judgement": report["judgement"],
                    }
                    for report in reports
                ],
            }
        items.append({
            "source_key": item["source_key"],
            "evidence_key": evidence_key,
            "machine_name": item["machine_name"],
            "machine_number": item["machine_number"],
            "sequence": item["sequence"],
            "part_prefix": item["part_prefix"],
            "part_nos": item["part_nos"],
            "model_names": item["model_names"],
            "planned_quantity": item["planned_quantity"],
            "matching_report_count": item["matching_report_count"],
            "latest_report_dt": item["latest_report_dt"],
            "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
        })

    return {
        "source": "quality_daily_attention",
        "schema_version": QUALITY_ATTENTION_AI_SCHEMA_VERSION,
        "date": source["date"],
        "language": "bilingual",
        "model_id": model_id,
        "source_plan_hash": source["source_plan_hash"],
        "source_plan_last_changed_at": source["source_plan_last_changed_at"],
        "summary_basis": {
            "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
            "history_window": QUALITY_ATTENTION_HISTORY_WINDOW,
            "history_coverage": "all_history",
            "part_normalization": "uppercase_and_remove_whitespace_then_first_9_chars",
            "report_section": "all",
            "counts_are_backend_authoritative": True,
            "current_defect_claim_allowed": False,
        },
        "disclaimer": {
            "ko": "과거 품질 이력이며 현재 불량 발생을 의미하지 않습니다.",
            "zh": "仅为历史品质记录，不代表当前正在发生不良。",
        },
        "totals": {
            "plan_group_count": source["total_plan_count"],
            "matched_report_count": source["total_matching_reports"],
            "without_history_count": source["without_history_count"],
        },
        "items": items,
        "evidence_catalog": [evidence_catalog[key] for key in sorted(evidence_catalog)],
    }
