"""Optional, dated production candidates for the selected quality source rows.

These are associations to stored records, not proof of the defect's originating
machine or shift. No quality row, quantity, or recorded-machine filter changes.
"""

from collections import defaultdict
from datetime import timedelta
import hashlib
import json
import re

from django.db import DatabaseError

from injection.models import InjectionReport
from production.models import ProductionExecution, ProductionPlan

from .analysis import _add, _bucket, _concentration, _quantity, _text, recorded_machine_number


MAX_PRODUCTION_ROWS = 50_000
BASES = ("production_record", "stored_plan", "recorded_only", "ambiguous", "unmatched", "not_injection")
SUMMARY_FIELDS = dict(zip(BASES, (
    "production_record_match_count", "plan_match_count", "recorded_only_count",
    "ambiguous_count", "unmatched_count", "not_injection_count",
)))
LIMITATIONS = [
    "Production associations use only LQC_INJ reports, an exact full normalized part number, and an exact normalized model when the quality model is present.",
    "Imported date-only quality reports use their recorded date; manual reports before Shanghai 08:00 use the previous production business date. Neither identifies the defect's actual production shift.",
    "Positive injection daily reports and non-pending positive execution records are dated production evidence, not proof of defect origin; duplicate source rows do not multiply quality counts.",
    "Plans are the currently stored plan for that date and may have been replaced after the incident; a unique plan is a reference candidate, not confirmed production.",
    "Conflicting or multiple machine candidates are not resolved by guessing. Recorded machine identifiers are never overwritten, including when they conflict with production candidates.",
    "The source quality calendar date, section and recorded-machine filters remain unchanged. Auxiliary candidate machines do not expand the selected quality row set.",
    "Model displays use only the quality report model and its recorded item name, with exact B/C, C/A and G/P aliases normalized and repeated item tokens suppressed. Blank report models remain blank even when an item name exists; no current master fills historical labels.",
    "All report counts and known quantities include unmatched and ambiguous records; these are report concentrations, not defect rates or shares of produced units.",
]


class _ProductionRowLimitExceeded(Exception):
    pass


def _part(value):
    return re.sub(r"\s+", "", _text(value)).upper()


def _model(value):
    return _text(value).upper()


def _machine(value):
    if type(value) is int:
        return value if 1 <= value <= 17 else None
    text = _text(value)
    if re.fullmatch(r"(?:[1-9]|1[0-7])", text):
        return int(text)
    return recorded_machine_number(text)


def _model_display(model, item):
    if not model:
        return ""
    aliases = {"BC": "B/C", "B/C": "B/C", "CA": "C/A", "C/A": "C/A", "GP": "G/P", "G/P": "G/P"}
    token = re.compile(r"(?<![A-Z0-9])(?:B/C|BC|C/A|CA|G/P|GP)(?![A-Z0-9])", re.IGNORECASE)
    displayed = token.sub(lambda match: aliases[match.group(0).upper()], model)
    item = aliases.get(item.upper(), item)
    if not item or re.search(r"(?<![\w])" + re.escape(item) + r"(?![\w])", displayed, re.IGNORECASE):
        return displayed
    return f"{displayed} - {item}"


def collect_context_row(row, report_at, recorded_machine, part):
    """Called only after the core aggregator has applied all quality filters."""
    imported = row.get("source_import_row__id") is not None or bool(row.get("excel_import_key"))
    business_date = report_at.date()
    if not imported and report_at.hour < 8 and business_date.toordinal() > 1:
        business_date -= timedelta(days=1)
    item = row.get("source_import_row__item_name")
    if item is None:
        item = row.get("excel_source__item_name")
    model, item = _text(row.get("model")), _text(item)
    # A manually supplied product classification is not available on QualityReport;
    # its section means inspection department and must not become a product type.
    display = _model_display(model, item)
    return {
        "id": row["id"], "date": report_at.date(), "business_date": business_date,
        "section": row["section"], "model": model, "model_display": display,
        "part_no": part, "machine_number": recorded_machine, "defect_qty": _quantity(row.get("defect_qty")),
    }


def _load_candidates(rows):
    wanted = {(row["business_date"], row["part_no"]) for row in rows
              if row["section"] == "LQC_INJ" and row["part_no"]}
    actual, planned = defaultdict(set), defaultdict(set)
    if not wanted:
        return actual, planned
    dates = [key[0] for key in wanted]
    first, last = min(dates), max(dates)
    sources = (
        (InjectionReport.objects.filter(date__gte=first, date__lte=last, actual_qty__gt=0)
         .order_by("date", "id").values("date", "part_no", "model", "machine_no"),
         actual, "date", "model", "machine_no"),
        (ProductionExecution.objects.filter(plan_date__gte=first, plan_date__lte=last,
                                            plan_type="injection", actual_qty__gt=0,
                                            status__in=("running", "completed", "paused"))
         .order_by("plan_date", "id").values("plan_date", "part_no", "model_name", "machine_name"),
         actual, "plan_date", "model_name", "machine_name"),
        (ProductionPlan.objects.filter(plan_date__gte=first, plan_date__lte=last,
                                       plan_type="injection", planned_quantity__gt=0)
         .order_by("plan_date", "id").values("plan_date", "part_no", "model_name", "machine_name"),
         planned, "plan_date", "model_name", "machine_name"),
    )
    scanned = 0
    for queryset, destination, date_field, model_field, machine_field in sources:
        # One shared cap includes irrelevant source rows; no truncated candidates
        # can accidentally become a falsely unique machine.
        for source in queryset[:MAX_PRODUCTION_ROWS - scanned + 1].iterator(chunk_size=1000):
            scanned += 1
            if scanned > MAX_PRODUCTION_ROWS:
                raise _ProductionRowLimitExceeded
            key = (source[date_field], _part(source["part_no"]))
            if key in wanted:
                destination[key].add((_model(source[model_field]), _machine(source[machine_field])))
    return actual, planned


def _resolve(row, actual, planned):
    recorded = row["machine_number"]
    if row["section"] != "LQC_INJ":
        return recorded, "not_injection"
    key = (row["business_date"], row["part_no"])
    model = _model(row["model"])
    production_rows, plan_rows = actual.get(key, set()), planned.get(key, set())
    production = {machine for candidate_model, machine in production_rows if not model or candidate_model == model}
    plans = {machine for candidate_model, machine in plan_rows if not model or candidate_model == model}
    # Present but contradictory model evidence must not be hidden by falling
    # through to a lower-priority plan or to a recorded-only success label.
    model_conflict = bool(model and ((production_rows and not production) or (plan_rows and not plans)))
    candidates = production | plans
    if model_conflict or None in candidates or len(candidates) > 1:
        return recorded, "ambiguous"
    if candidates:
        candidate = next(iter(candidates))
        if recorded is not None and recorded != candidate:
            return recorded, "ambiguous"
        return recorded if recorded is not None else candidate, "production_record" if production else "stored_plan"
    return recorded, "recorded_only" if recorded is not None else "unmatched"


def _group_key(machine, model_display, part):
    serialized = json.dumps([machine, model_display, part], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _aggregate(rows, actual, planned, *, status="ready", failure=None):
    model_parts, machine_models = {}, {}
    summary = {"report_count": len(rows), **{field: 0 for field in SUMMARY_FIELDS.values()}, "missing_model_count": 0}
    for row in rows:
        machine, basis = _resolve(row, actual, planned)
        summary[SUMMARY_FIELDS[basis]] += 1
        summary["missing_model_count"] += int(not row["model"])
        for groups, grouping_machine in ((model_parts, None), (machine_models, machine)):
            key = _group_key(grouping_machine, row["model_display"], row["part_no"])
            group = groups.setdefault(key, {
                **_bucket(), "label": row["model_display"] or row["part_no"] or "미입력 / 未填写",
                "model_display": row["model_display"], "part_no": row["part_no"], "machine_number": grouping_machine,
                "match_basis_counts": {name: 0 for name in BASES},
            })
            _add(group, row, row["defect_qty"])
            group["match_basis_counts"][basis] += 1
    limitations = list(LIMITATIONS)
    if failure:
        limitations.append(f"Production candidate lookup unavailable ({failure}); only recorded quality labels and machines are shown. No partial production attribution is returned.")
    return {
        "schema_version": "quality-production-context.v1", "status": status,
        "policy": "unique_dated_part_model_candidate_v1", "summary": summary,
        "model_parts": _concentration(model_parts, len(rows)),
        "machine_models": _concentration(machine_models, len(rows)), "limitations": limitations,
    }


def build_production_context(rows):
    """Rows have already passed the core quality selection; source I/O is bounded."""
    try:
        actual, planned = _load_candidates(rows)
    except _ProductionRowLimitExceeded:
        return _aggregate(rows, {}, {}, status="unavailable", failure="source_row_limit_exceeded")
    except DatabaseError:
        return _aggregate(rows, {}, {}, status="unavailable", failure="source_query_failed")
    return _aggregate(rows, actual, planned)
