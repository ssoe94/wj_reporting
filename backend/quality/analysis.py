"""Read-only, bounded analysis of recorded quality incidents.

These records are not the complete population of inspected production. No
factory defect rate, yield, or inferred historical equipment is calculated.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
import re
import unicodedata
from zoneinfo import ZoneInfo

from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .daily_attention import _canonical_problem_types
from .injection_terminology import INJECTION_TERMINOLOGY_VERSION
from .models import QualityReport


SHANGHAI = ZoneInfo("Asia/Shanghai")
MAX_DAYS = 366
MAX_SOURCE_ROWS = 50_000
TOP_N = 20
SAMPLE_IDS = 5
SECTION_LABELS = {
    "LQC_INJ": {"ko": "사출 공정검사", "zh": "注塑过程检验"},
    "LQC_ASM": {"ko": "조립 공정검사", "zh": "组装过程检验"},
    "IQC": {"ko": "수입검사", "zh": "来料检验"},
    "OQC": {"ko": "출하검사", "zh": "出货检验"},
    "CS": {"ko": "고객 품질", "zh": "客户品质"},
}


def parse_analysis_filters(params, *, today=None):
    today = today or timezone.now().astimezone(SHANGHAI).date()
    keys = ("start_date", "end_date", "section", "machine_number")
    if hasattr(params, "getlist") and any(len(params.getlist(key)) > 1 for key in keys):
        raise ValidationError({"filters": "Each filter must be supplied once."})

    def parse_day(key, default):
        raw = params.get(key)
        if raw is None:
            return default
        try:
            if not isinstance(raw, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
                raise ValueError
            return date.fromisoformat(raw)
        except ValueError as exc:
            raise ValidationError({key: "Use a valid YYYY-MM-DD date."}) from exc

    end = parse_day("end_date", today)
    start = parse_day("start_date", date.fromordinal(max(date.min.toordinal(), end.toordinal() - 29)))
    if end > today or start > end or (end - start).days + 1 > MAX_DAYS:
        raise ValidationError({"date_range": "Choose an ordered, non-future range of at most 366 days."})
    section = params.get("section")
    if section is not None and section not in SECTION_LABELS:
        raise ValidationError({"section": "Choose LQC_INJ, LQC_ASM, IQC, OQC or CS; omit for all."})
    machine = params.get("machine_number")
    if machine is not None and machine != "unknown":
        if not isinstance(machine, str) or not re.fullmatch(r"(?:[1-9]|1[0-7])", machine):
            raise ValidationError({"machine_number": "Choose 1..17 or unknown; omit for all."})
        machine = int(machine)
    return {"start_date": start, "end_date": end, "section": section, "machine_number": machine}


def _text(value):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def recorded_machine_number(location):
    """Accept only an explicit equipment identifier in the recorded location."""
    text = _text(location).upper()
    if re.search(r"\d+\s*[/,、~-]\s*\d+\s*(?:호기|号机|號機)|(?:호기|号机|號機)\s*[/,、~-]\s*\d", text):
        return None
    matches = set()
    for pattern in (
        r"(?<![A-Z0-9])IMM\s*[-#]?\s*(\d+)(?![A-Z0-9.]|\s*[/,、~-]\s*\d)",
        r"(?<![\d.])(\d+)\s*(?:호기|号机|號機)",
        r"(?<![\d.])\d{2,4}\s*T\s*-\s*(\d+)(?![\d.]|\s*[/,、~-]\s*\d)",
        r"(?:机台|機台|사출기)\s*[:#-]?\s*(\d+)(?![\d.]|\s*[/,、~-]\s*\d)",
    ):
        matches.update(int(match) for match in re.findall(pattern, text))
    if len(matches) != 1:
        return None
    machine = next(iter(matches))
    return machine if 1 <= machine <= 17 else None


def _quantity(value):
    return value if type(value) is int and value >= 0 else None


def _bucket():
    return {"report_count": 0, "defect_quantity_record_count": 0, "reported_defect_qty": None,
            "sample_report_ids": []}


def _add(bucket, row, quantity):
    bucket["report_count"] += 1
    if quantity is not None:
        bucket["defect_quantity_record_count"] += 1
        bucket["reported_defect_qty"] = (bucket["reported_defect_qty"] or 0) + quantity
    if len(bucket["sample_report_ids"]) < SAMPLE_IDS:
        bucket["sample_report_ids"].append(row["id"])


def _group_items(groups, total):
    items = []
    for key, group in sorted(groups.items(), key=lambda item: (-item[1]["report_count"], item[0])):
        items.append({"key": key, **group,
                      "share_of_reports_percent": round(group["report_count"] / total * 100, 2) if total else 0})
    return items


def _concentration(groups, total):
    items = _group_items(groups, total)
    return {"items": items[:TOP_N], "total_group_count": len(items), "top_n": TOP_N,
            "other_report_count": sum(item["report_count"] for item in items[TOP_N:])}


def aggregate_quality_analysis(rows, filters, *, generated_at=None):
    """Aggregate projected source rows once, without serializers or per-row queries."""
    start, end = filters["start_date"], filters["end_date"]
    trend = {}
    day = start
    while day <= end:
        trend[day.isoformat()] = _bucket()
        day += timedelta(days=1)
    pareto, machines, parts, sections = {}, {}, {}, {}
    machine_options = defaultdict(int)
    duplicate_keys = defaultdict(int)
    summary = {**_bucket(), "inspection_quantity_record_count": 0, "recorded_inspection_qty": None,
               "zero_defect_report_count": 0, "latest_report_at": None}
    quality = {key: 0 for key in (
        "missing_defect_qty_count", "missing_inspection_qty_count", "invalid_quantity_count",
        "inconsistent_quantity_count", "paired_quantity_record_count", "missing_part_count",
        "missing_phenomenon_count", "unclassified_type_count", "multi_type_count",
        "unassigned_machine_count", "duplicate_candidate_group_count", "duplicate_candidate_report_count",
    )}
    latest_report = latest_updated = None
    selected_machine = filters["machine_number"]
    scanned = 0
    for row in rows:
        scanned += 1
        if scanned > MAX_SOURCE_ROWS:
            raise ValidationError({"date_range": "More than 50,000 source records; narrow the date or section filter. No partial totals returned."})
        report_at = row["report_dt"]
        if timezone.is_naive(report_at):
            report_at = report_at.replace(tzinfo=SHANGHAI)
        local_date = report_at.astimezone(SHANGHAI).date().isoformat()
        # The query applies these filters; keep the pure function equally scoped.
        if local_date not in trend or (filters["section"] and row["section"] != filters["section"]):
            continue
        location = row.get("source_import_row__occurrence_location")
        if location is None:
            location = row.get("excel_source__occurrence_location")
        machine = recorded_machine_number(location)
        machine_key = str(machine) if machine is not None else "unknown"
        machine_options[machine_key] += 1
        if selected_machine is not None and machine_key != str(selected_machine):
            continue
        defect, inspection = _quantity(row.get("defect_qty")), _quantity(row.get("inspection_qty"))
        part = re.sub(r"\s+", "", _text(row.get("part_no"))).upper()
        phenomenon = _text(row.get("phenomenon"))
        section = _text(row.get("section")) or "unknown"
        _add(summary, row, defect)
        _add(trend[local_date], row, defect)
        if inspection is not None:
            summary["inspection_quantity_record_count"] += 1
            summary["recorded_inspection_qty"] = (summary["recorded_inspection_qty"] or 0) + inspection
        summary["zero_defect_report_count"] += int(defect == 0)
        quality["missing_defect_qty_count"] += int(row.get("defect_qty") is None)
        quality["missing_inspection_qty_count"] += int(row.get("inspection_qty") is None)
        quality["invalid_quantity_count"] += int(
            (row.get("defect_qty") is not None and defect is None)
            or (row.get("inspection_qty") is not None and inspection is None)
        )
        quality["paired_quantity_record_count"] += int(defect is not None and inspection is not None)
        quality["inconsistent_quantity_count"] += int(defect is not None and inspection is not None and defect > inspection)
        quality["missing_part_count"] += int(not part)
        quality["missing_phenomenon_count"] += int(not phenomenon)
        quality["unassigned_machine_count"] += int(machine is None)

        types = _canonical_problem_types(phenomenon)
        if len(types) > 1:
            kind, label = "multiple", {"ko": "복합 유형", "zh": "复合类型"}
            quality["multi_type_count"] += 1
        else:
            kind, label = types[0]["key"], types[0]["label"]
            quality["unclassified_type_count"] += int(kind == "unclassified")
        for groups, key, label_value in (
            (pareto, kind, label),
            (machines, machine_key, f"IMM{machine:02d}" if machine is not None else "미지정 / 未关联"),
            (parts, part or "unknown", part or "미입력 / 未填写"),
            (sections, section, section),
        ):
            group = groups.setdefault(key, {**_bucket(), "label": label_value})
            _add(group, row, defect)

        # This is an advisory candidate key, not an event ID. Distinct incidents
        # can match; none are automatically removed from any reported totals.
        if part and phenomenon:
            duplicate_keys[(local_date, section, part, phenomenon.casefold(),
                            _text(location).casefold(), defect, inspection, row.get("lot_qty"),
                            _text(row.get("judgement")).upper())] += 1
        latest_report = max(latest_report, report_at) if latest_report else report_at
        updated = row.get("updated_at")
        if updated:
            latest_updated = max(latest_updated, updated) if latest_updated else updated

    total = summary["report_count"]
    summary.pop("sample_report_ids")
    summary["latest_report_at"] = latest_report.isoformat() if latest_report else None
    candidates = [count for count in duplicate_keys.values() if count > 1]
    quality["duplicate_candidate_group_count"] = len(candidates)
    quality["duplicate_candidate_report_count"] = sum(candidates)
    pareto_items = _group_items(pareto, total)
    cumulative = 0
    for item in pareto_items:
        cumulative += item["report_count"]
        item["cumulative_report_share_percent"] = round(cumulative / total * 100, 2) if total else 0
    warnings = []
    for field, code in (
        ("missing_defect_qty_count", "defect_quantity_incomplete"),
        ("missing_inspection_qty_count", "inspection_quantity_incomplete"),
        ("invalid_quantity_count", "invalid_quantities_excluded"),
        ("inconsistent_quantity_count", "defect_quantity_exceeds_inspection"),
        ("unassigned_machine_count", "recorded_machine_coverage_incomplete"),
        ("missing_part_count", "part_number_incomplete"),
        ("missing_phenomenon_count", "phenomenon_incomplete"),
        ("unclassified_type_count", "defect_type_unclassified"),
        ("multi_type_count", "multiple_types_kept_in_one_bucket"),
        ("duplicate_candidate_report_count", "duplicate_candidates_not_removed"),
    ):
        if quality[field]:
            warnings.append(code)
    return {
        "schema_version": "quality-analysis.v1",
        "status": "no_records" if not total else "partial" if warnings else "ok",
        "filters": {**filters, "start_date": start.isoformat(), "end_date": end.isoformat(),
                    "timezone": "Asia/Shanghai", "date_basis": "report_dt_calendar_day"},
        "summary": summary,
        "trend": [{"date": key, **{k: v for k, v in value.items() if k != "sample_report_ids"}}
                  for key, value in trend.items()],
        "pareto": pareto_items,
        "concentrations": {"machines": _concentration(machines, total),
                           "parts": _concentration(parts, total), "sections": _concentration(sections, total)},
        "data_quality": quality,
        "options": {
            "sections": [{"value": key, "label": value} for key, value in SECTION_LABELS.items()],
            "machines": [{"value": key, "label": f"IMM{int(key):02d}" if key != "unknown" else "미지정 / 未关联",
                          "report_count": count}
                         for key, count in sorted(machine_options.items(), key=lambda item: (item[0] == "unknown", int(item[0]) if item[0] != "unknown" else 99))],
            "scope": "date_and_section_before_machine_filter",
        },
        "freshness": {"generated_at": (generated_at or timezone.now()).isoformat(),
                      "latest_report_at": summary["latest_report_at"],
                      "latest_updated_at": latest_updated.isoformat() if latest_updated else None,
                      "refresh_policy": "event_driven"},
        "source": {"model": "QualityReport", "source_row_count_before_machine_filter": sum(machine_options.values()),
                   "row_limit": MAX_SOURCE_ROWS, "sample_ids_per_group": SAMPLE_IDS,
                   "classification_version": INJECTION_TERMINOLOGY_VERSION},
        "warnings": warnings,
        "limitations": [
            "Recorded quality incidents are not the full production or inspection population; no factory defect rate or yield is calculated.",
            "Recorded inspection quantities may repeat the same lot and are not unique inspected units.",
            "Machine assignment uses explicit identifiers in recorded occurrence_location only; unknown locations are not inferred from production plans.",
            "Duplicate candidates remain in all totals until a human verifies distinct incidents or duplicates.",
            "No-record dates mean no recorded incidents, not confirmed zero defects or completed inspection.",
            "Missing quantities remain unknown; reported quantity sums cover only records with a valid nonnegative integer quantity.",
        ],
        "calculation_basis": [
            "Date = report_dt in Asia/Shanghai, calendar day 00:00 to next day 00:00; this is not the MES 08:00 business day.",
            "Pareto is ordered by report count; each report belongs to exactly one bucket, with multiple matched types grouped as multiple.",
            "Concentration shares use all selected report counts; only the top 20 groups are returned with other_report_count.",
            "Duplicate candidates share date, section, exact normalized part and phenomenon, recorded location, quantities and judgement; this is not confirmed identity.",
        ],
    }


def build_quality_analysis(filters):
    start = datetime.combine(filters["start_date"], time.min, tzinfo=SHANGHAI)
    end = datetime.combine(filters["end_date"] + timedelta(days=1), time.min, tzinfo=SHANGHAI)
    queryset = QualityReport.objects.filter(report_dt__gte=start, report_dt__lt=end)
    if filters["section"]:
        queryset = queryset.filter(section=filters["section"])
    # One projected, streamed query including the optional one-to-one source
    # row. Do not serialize all reports or query imports once per report.
    rows = queryset.order_by("-report_dt", "-id").values(
        "id", "report_dt", "updated_at", "section", "part_no", "phenomenon", "judgement",
        "lot_qty", "inspection_qty", "defect_qty", "source_import_row__occurrence_location",
        "excel_source__occurrence_location",
    )[:MAX_SOURCE_ROWS + 1].iterator(chunk_size=1000)
    return aggregate_quality_analysis(rows, filters)
