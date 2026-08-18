"""Shared deterministic source for the daily quality-attention page and AI job.

The production plan and all matching historical quality reports are joined by
the page's established normalized nine-character part-number prefix.  Counts,
dates, trends and impact scope are calculated here; the local LLM is limited
to selecting grounded evidence keys and priority order.  Public bilingual
prose is rendered from server-owned templates.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from typing import Any, Iterable
import unicodedata
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.db.models import Max

from production.models import ProductionPlan, ProductionPlanChangeLog

from .models import QualityReport


QUALITY_ATTENTION_MATCH_BASIS = "part_prefix_9"
QUALITY_ATTENTION_HISTORY_WINDOW = "all"
QUALITY_ATTENTION_AI_SCHEMA_VERSION = "quality-daily-attention-ai.v1"
QUALITY_DAILY_REPORT_SCHEMA_VERSION = "quality-daily-report.v1"
QUALITY_TREND_WINDOW_DAYS = 30
QUALITY_TREND_MIN_WINDOW_DENOMINATOR = 5
QUALITY_TREND_MIN_COMBINED_ISSUE_COUNT = 3
QUALITY_EVIDENCE_SNAPSHOT_CACHE_SECONDS = 5 * 60
QUALITY_PHENOMENON_TAXONOMY_VERSION = "server_canonical_alias_v1"

_SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
_NO_PHENOMENON_MARKER = "[NO_PHENOMENON_RECORDED]"
_UNKNOWN_PROBLEM_LABEL = {"ko": "현상 미입력", "zh": "未填写现象"}
_UNKNOWN_LOCATION_LABEL = {"ko": "위치 미확인", "zh": "位置未确认"}

# Server-owned phenomenon taxonomy.  Aliases intentionally follow the
# long-standing daily-attention UI normalization and add conservative Korean /
# English equivalents.  A report can belong to multiple explicit categories;
# unmatched text remains a separate, auditable unclassified bucket.
_PHENOMENON_TAXONOMY = (
    ("contamination", {"ko": "오염·이물", "zh": "脏污·异物"},
     ("脏污", "油污", "油渍", "油点", "灰尘", "污渍", "擦拭印", "오염", "이물", "기름때", "얼룩", "먼지", "contamination", "stain")),
    ("white_powder_residue", {"ko": "백색 분말 잔류", "zh": "白色粉末残留"},
     ("白色粉末", "粉末残留", "백색분말", "분말잔류", "powderresidue")),
    ("burr_flash", {"ko": "버·플래시", "zh": "毛刺·飞边"},
     ("毛刺", "飞边", "바리", "플래시", "burr", "flash")),
    ("lint_residue", {"ko": "보풀·섬유 잔류", "zh": "毛絮残留"},
     ("毛絮", "보풀", "섬유잔류", "lint")),
    ("scorch_mark", {"ko": "탄화·그을음", "zh": "糊斑·烧焦"},
     ("糊斑", "烧焦", "燒焦", "탄화", "그을음", "burnmark", "scorch")),
    ("gas_mark_whitening", {"ko": "가스 자국·백화", "zh": "气印·白化"},
     ("气印", "氣印", "白化", "顶白", "頂白", "가스자국", "백화", "gasmark", "whitening")),
    ("sink_mark", {"ko": "수축 자국", "zh": "缩印"},
     ("缩印", "縮印", "缩影", "縮影", "缩水", "縮水", "수축", "sinkmark")),
    ("short_shot", {"ko": "미성형·쇼트", "zh": "缺胶"},
     ("缺胶", "缺膠", "미성형", "쇼트", "shortshot")),
    ("gloss", {"ko": "광택 이상", "zh": "发亮·高光"},
     ("发亮", "發亮", "高光", "광택", "번들거림", "gloss")),
    ("scratch_damage", {"ko": "스크래치·찍힘", "zh": "擦伤·碰伤"},
     ("拉伤", "拉傷", "擦伤", "擦傷", "削伤", "削傷", "磕伤", "磕傷", "夹伤", "夾傷", "损伤", "損傷", "스크래치", "긁힘", "찍힘", "scratch", "damage")),
    ("color_black_material", {"ko": "이색·흑점·재료무늬", "zh": "夹色·黑点·料花"},
     ("夹色", "夾色", "黑点", "黑點", "料花", "이색", "흑점", "실버", "blackspot")),
    ("label_abnormality", {"ko": "라벨 이상", "zh": "标签异常"},
     ("标签", "標籤", "重码", "重碼", "漏贴", "漏貼", "라벨", "중복코드", "누락부착", "label")),
    ("packaging_abnormality", {"ko": "포장 이상", "zh": "包装异常"},
     ("包装", "包裝", "包裹", "水渍", "水漬", "포장", "수분자국", "packaging")),
    ("deformation", {"ko": "변형", "zh": "变形"},
     ("变形", "變形", "변형", "deformation", "warpage")),
    ("crack", {"ko": "균열", "zh": "裂纹"},
     ("裂纹", "裂紋", "开裂", "開裂", "균열", "크랙", "crack")),
    ("flow_weld_mark", {"ko": "흐름·웰드 자국", "zh": "流痕·熔接线"},
     ("流痕", "流纹", "流紋", "熔接线", "熔接線", "웰드", "흐름자국", "flowmark", "weldline")),
)

# Location is intentionally fail-closed.  Only an explicit recorded keyword is
# mapped; everything else remains unknown instead of asking the LLM to infer.
_EXPLICIT_LOCATION_RULES = (
    ("gate", {"ko": "게이트부", "zh": "浇口部"}, ("게이트", "gate", "浇口", "澆口", "进胶", "進膠")),
    ("hole", {"ko": "홀·구멍부", "zh": "孔位"}, ("홀", "구멍", "hole", "孔位", "孔部", "孔边", "孔邊")),
    ("edge", {"ko": "모서리·테두리", "zh": "边缘"}, ("모서리", "테두리", "edge", "边缘", "邊緣", "边角", "邊角")),
    ("corner", {"ko": "코너부", "zh": "角部"}, ("코너", "corner", "角部", "角位", "角落")),
    ("surface", {"ko": "표면", "zh": "表面"}, ("표면", "surface", "表面")),
    ("inside", {"ko": "내측", "zh": "内侧"}, ("내측", "안쪽", "inner", "内侧", "內側", "内部", "內部")),
    ("outside", {"ko": "외측", "zh": "外侧"}, ("외측", "바깥", "outer", "外侧", "外側")),
    ("top", {"ko": "상단", "zh": "顶部"}, ("상단", "윗면", "top", "顶部", "頂部", "上部")),
    ("bottom", {"ko": "하단", "zh": "底部"}, ("하단", "아랫면", "bottom", "底部", "下部")),
    ("side", {"ko": "측면", "zh": "侧面"}, ("측면", "side", "侧面", "側面")),
    ("boss", {"ko": "보스부", "zh": "柱位"}, ("보스", "boss", "柱位", "螺丝柱", "螺絲柱")),
    ("rib", {"ko": "리브부", "zh": "筋位"}, ("리브", "rib", "筋位")),
    ("parting_line", {"ko": "파팅라인", "zh": "分型线"}, ("파팅", "parting", "分型线", "分型線")),
)


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


def _normalized_phenomenon_text(value: Any) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    normalized = re.sub(r"[\r\n\t]+", " ", normalized)
    normalized = re.sub(r"[，、,;；/／|]+", " ", normalized)
    normalized = re.sub(r"[。．.]+$", "", normalized.strip())
    return re.sub(r"\s+", "", normalized).casefold()


def _canonical_problem_types(phenomenon: Any) -> list[dict[str, Any]]:
    raw = _clean_text(phenomenon)
    normalized = _normalized_phenomenon_text(raw)
    if not normalized:
        return [{
            "key": "missing",
            "metric_key": "problem:missing",
            "label": dict(_UNKNOWN_PROBLEM_LABEL),
            "classification_basis": "missing_recorded_phenomenon",
            "recorded_text": "",
        }]

    matches = []
    for key, label, aliases in _PHENOMENON_TAXONOMY:
        if any(_normalized_phenomenon_text(alias) in normalized for alias in aliases):
            matches.append({
                "key": key,
                "metric_key": f"problem:{key}",
                "label": dict(label),
                "classification_basis": "canonical_alias_v1",
            })
    if matches:
        return matches

    # Unknown text is not merged with unrelated phenomena and is not assigned
    # a guessed category.  The stable hash keeps repeat counts auditable while
    # the recorded label remains visible on the authenticated report page.
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
    return [{
        "key": f"unclassified:{digest}",
        "metric_key": f"problem:unclassified:{digest}",
        "label": {"ko": raw, "zh": raw},
        "classification_basis": "unclassified_recorded_text_hash",
        "recorded_text": raw,
    }]


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
        "updated_at",
    ]
    if include_images:
        report_fields.extend(("image1", "image2", "image3", "image4", "image5"))
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


def _canonical_evidence_rows(
    report_groups: dict[str, list[QualityReport]],
) -> list[dict[str, Any]]:
    reports: dict[int, QualityReport] = {}
    for grouped_reports in report_groups.values():
        for report in grouped_reports:
            reports.setdefault(report.id, report)
    return [
        {
            "id": report.id,
            "report_dt": report.report_dt.isoformat(),
            "part_no": normalize_part_no(report.part_no),
            "model": _clean_text(report.model),
            "phenomenon": str(report.phenomenon or ""),
            "section": _clean_text(report.section),
            "updated_at": report.updated_at.isoformat(),
        }
        for report in sorted(reports.values(), key=lambda value: value.id)
    ]


def quality_attention_evidence_hash(
    report_groups: dict[str, list[QualityReport]],
) -> str:
    encoded = json.dumps(
        {
            "taxonomy_version": QUALITY_PHENOMENON_TAXONOMY_VERSION,
            "reports": _canonical_evidence_rows(report_groups),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def quality_attention_evidence_snapshot(
    target_date: date,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    plan_rows = _plan_rows(target_date)
    source_plan_hash = quality_attention_plan_hash(plan_rows)
    prefixes = {
        prefix
        for prefix in (part_prefix(row.get("part_no")) for row in plan_rows)
        if prefix
    }
    if not prefixes:
        return {
            "date": target_date.isoformat(),
            "source_evidence_hash": None,
            "source_evidence_last_changed_at": None,
            "matching_report_count": 0,
        }
    cache_key = (
        "quality-attention:evidence-snapshot:"
        f"{QUALITY_PHENOMENON_TAXONOMY_VERSION}:"
        f"{target_date.isoformat()}:{source_plan_hash}"
    )
    if not force_refresh:
        try:
            cached = cache.get(cache_key)
        except Exception:  # pragma: no cover - cache backend failure is deployment-specific
            cached = None
        if isinstance(cached, dict) and cached.get("source_evidence_hash"):
            return dict(cached)
    report_groups = _report_groups(prefixes, include_images=False)
    evidence_rows = _canonical_evidence_rows(report_groups)
    latest_changed = max(
        (report.updated_at for reports in report_groups.values() for report in reports),
        default=None,
    )
    result = {
        "date": target_date.isoformat(),
        # The empty report set is still real evidence state and therefore has
        # a stable, non-empty hash.  Only a missing plan yields ``None``.
        "source_evidence_hash": quality_attention_evidence_hash(report_groups),
        "source_evidence_last_changed_at": (
            latest_changed.isoformat() if latest_changed else None
        ),
        "matching_report_count": len(evidence_rows),
    }
    try:
        cache.set(
            cache_key,
            result,
            timeout=QUALITY_EVIDENCE_SNAPSHOT_CACHE_SECONDS,
        )
    except Exception:  # pragma: no cover - cache backend failure is deployment-specific
        pass
    return result


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
    prefixes = {
        prefix
        for prefix in (part_prefix(row.get("part_no")) for row in plan_rows)
        if prefix
    }
    report_groups = _report_groups(prefixes, include_images=include_images)
    source_evidence_hash = (
        quality_attention_evidence_hash(report_groups) if prefixes else None
    )
    latest_evidence_change = max(
        (report.updated_at for reports in report_groups.values() for report in reports),
        default=None,
    )

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
                "plan_targets": [],
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
        planned_quantity = _rounded_quantity(row.get("planned_quantity"))
        group["planned_quantity"] += planned_quantity
        group["plan_row_count"] += 1
        group["plan_targets"].append({
            "machine_name": machine_name,
            "sequence": row.get("sequence"),
            "model_name": model_name,
            "part_no": normalized_part_no,
            "lot_no": lot_no,
            "planned_quantity": planned_quantity,
        })

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
                    for image in (
                        report.image1, report.image2, report.image3,
                        report.image4, report.image5,
                    )
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
    result = {
        "date": target_date.isoformat(),
        "history_window": QUALITY_ATTENTION_HISTORY_WINDOW,
        "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
        "source_plan_hash": (
            quality_attention_plan_hash(plan_rows) if grouped_plan_rows else None
        ),
        "source_plan_last_changed_at": latest_change.isoformat() if latest_change else None,
        "source_evidence_hash": source_evidence_hash,
        "source_evidence_last_changed_at": (
            latest_evidence_change.isoformat() if latest_evidence_change else None
        ),
        "total_plan_count": len(items),
        # A shared prefix can be planned on multiple machines.  Per-target
        # counts may repeat, while the board-level total counts each report once.
        "total_matching_reports": len(matching_report_ids),
        "without_history_count": without_history,
        "items": items,
    }
    result["report_metrics"] = build_daily_quality_report_metrics(result, target_date)
    return result


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
            text = _NO_PHENOMENON_MARKER
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
            "is_missing_text": group["text"] == _NO_PHENOMENON_MARKER,
            "count": len(report_ids),
            "report_ids": report_ids,
            "report_dates": report_dates,
            "latest_report_dt": report_dates[0] if report_dates else None,
        })
    return sorted(result, key=lambda item: (-item["count"], item["text"]))


def _phenomenon_evidence_key(part_prefix_value: str, text: str) -> str:
    recorded = text or _NO_PHENOMENON_MARKER
    digest = hashlib.sha256(f"phenomenon\0{recorded}".encode("utf-8")).hexdigest()[:12]
    return f"{part_prefix_value}:phenomenon:{digest}"


def _report_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_SHANGHAI_TZ)
    return parsed.astimezone(_SHANGHAI_TZ)


def _explicit_occurrence_locations(phenomenon: str) -> list[dict[str, Any]]:
    normalized = phenomenon.casefold()

    def has_token(token: str) -> bool:
        candidate = token.casefold()
        if candidate.isascii() and candidate.isalpha():
            return re.search(rf"\b{re.escape(candidate)}\b", normalized) is not None
        return candidate in normalized

    result = []
    for key, label, tokens in _EXPLICIT_LOCATION_RULES:
        if any(has_token(token) for token in tokens):
            result.append({"key": key, "label": dict(label)})
    return result or [{"key": "unknown", "label": dict(_UNKNOWN_LOCATION_LABEL)}]


def _trend_metrics(
    issue_report_ids: set[int],
    denominator_report_ids: set[int],
    report_dates: dict[int, date],
    *,
    target_date: date,
) -> dict[str, Any]:
    recent_end = target_date
    recent_start = recent_end - timedelta(days=QUALITY_TREND_WINDOW_DAYS - 1)
    previous_end = recent_start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=QUALITY_TREND_WINDOW_DAYS - 1)

    def count_in_window(report_ids: set[int], start: date, end: date) -> int:
        return sum(
            1
            for report_id in report_ids
            if (report_date := report_dates.get(report_id)) is not None
            and start <= report_date <= end
        )

    recent_count = count_in_window(issue_report_ids, recent_start, recent_end)
    previous_count = count_in_window(issue_report_ids, previous_start, previous_end)
    recent_denominator = count_in_window(denominator_report_ids, recent_start, recent_end)
    previous_denominator = count_in_window(denominator_report_ids, previous_start, previous_end)
    recent_share = (
        round(recent_count / recent_denominator * 100, 1)
        if recent_denominator
        else None
    )
    previous_share = (
        round(previous_count / previous_denominator * 100, 1)
        if previous_denominator
        else None
    )

    if not recent_denominator or not previous_denominator:
        status = "insufficient_data"
        reason = "zero_window_denominator"
    elif (
        recent_denominator < QUALITY_TREND_MIN_WINDOW_DENOMINATOR
        or previous_denominator < QUALITY_TREND_MIN_WINDOW_DENOMINATOR
    ):
        status = "insufficient_data"
        reason = "small_window_denominator"
    elif recent_count + previous_count < QUALITY_TREND_MIN_COMBINED_ISSUE_COUNT:
        status = "insufficient_data"
        reason = "small_issue_sample"
    elif (
        recent_count > previous_count
        and recent_share is not None
        and previous_share is not None
        and recent_share > previous_share
    ):
        status = "increase"
        reason = "count_and_share_increase"
    else:
        status = "stable_or_decrease"
        reason = "increase_rule_not_met"

    return {
        "status": status,
        "reason": reason,
        "recent_count": recent_count,
        "previous_count": previous_count,
        "recent_denominator": recent_denominator,
        "previous_denominator": previous_denominator,
        "recent_share_pct": recent_share,
        "previous_share_pct": previous_share,
        "share_change_pp": (
            round(recent_share - previous_share, 1)
            if recent_share is not None and previous_share is not None
            else None
        ),
        "count_change": recent_count - previous_count,
        "denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
    }


def _impact_scope(
    prefixes: set[str],
    report_ids: set[int],
    *,
    targets_by_prefix: dict[str, list[dict[str, Any]]],
    reports_by_id: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    targets: list[dict[str, Any]] = []
    plan_group_keys: set[str] = set()
    machine_names: set[str] = set()
    model_names: set[str] = set()
    part_nos: set[str] = set()
    planned_quantity = 0
    for prefix in sorted(prefixes):
        for item in targets_by_prefix.get(prefix, []):
            source_key = str(item.get("source_key") or "")
            if source_key in plan_group_keys:
                continue
            plan_group_keys.add(source_key)
            machine_name = _clean_text(item.get("machine_name"))
            if machine_name:
                machine_names.add(machine_name)
            model_names.update(_clean_text(value) for value in item.get("model_names") or [] if _clean_text(value))
            part_nos.update(normalize_part_no(value) for value in item.get("part_nos") or [] if normalize_part_no(value))
            planned_quantity += _rounded_quantity(item.get("planned_quantity"))
            targets.extend(item.get("plan_targets") or [])

    unique_targets: list[dict[str, Any]] = []
    target_keys: set[tuple[Any, ...]] = set()
    for target in targets:
        if not isinstance(target, dict):
            continue
        projected = {
            "machine_name": _clean_text(target.get("machine_name")),
            "sequence": target.get("sequence"),
            "model_name": _clean_text(target.get("model_name")),
            "part_no": normalize_part_no(target.get("part_no")),
            "lot_no": _clean_text(target.get("lot_no")),
            "planned_quantity": _rounded_quantity(target.get("planned_quantity")),
        }
        key = tuple(projected.values())
        if key not in target_keys:
            target_keys.add(key)
            unique_targets.append(projected)

    historical_models = {
        _clean_text(reports_by_id[report_id].get("model"))
        for report_id in report_ids
        if report_id in reports_by_id and _clean_text(reports_by_id[report_id].get("model"))
    }
    historical_parts = {
        normalize_part_no(reports_by_id[report_id].get("part_no"))
        for report_id in report_ids
        if report_id in reports_by_id and normalize_part_no(reports_by_id[report_id].get("part_no"))
    }
    return {
        "plan_group_count": len(plan_group_keys),
        "planned_quantity": planned_quantity,
        "machine_names": sorted(machine_names),
        "model_names": sorted(model_names),
        "part_nos": sorted(part_nos),
        "part_prefixes": sorted(prefixes),
        "plan_targets": unique_targets,
        "historical_model_names": sorted(historical_models),
        "historical_part_nos": sorted(historical_parts),
    }


def build_daily_quality_report_metrics(
    source: dict[str, Any],
    target_date: date,
) -> dict[str, Any]:
    """Build page/report metrics without asking the LLM to calculate or infer.

    Report ids remain an internal de-duplication key.  The returned contract has
    only compact aggregate evidence keys, counts and dates.
    """

    targets_by_prefix: dict[str, list[dict[str, Any]]] = defaultdict(list)
    reports_by_id: dict[int, dict[str, Any]] = {}
    report_ids_by_prefix: dict[str, set[int]] = defaultdict(set)
    report_dates: dict[int, date] = {}
    for item in source.get("items") or []:
        if not isinstance(item, dict):
            continue
        prefix = str(item.get("part_prefix") or "")
        if not prefix:
            continue
        targets_by_prefix[prefix].append(item)
        for report in item.get("reports") or []:
            if not isinstance(report, dict) or not isinstance(report.get("id"), int):
                continue
            report_id = report["id"]
            reports_by_id.setdefault(report_id, report)
            report_ids_by_prefix[prefix].add(report_id)
            parsed = _report_datetime(report.get("report_dt"))
            if parsed:
                report_dates[report_id] = parsed.date()

    problem_groups: dict[str, dict[str, Any]] = {}
    location_groups: dict[str, dict[str, Any]] = {}
    problem_location_pair_groups: dict[tuple[str, str], dict[str, Any]] = {}
    ambiguous_pair_report_ids: set[int] = set()
    for prefix, report_ids in report_ids_by_prefix.items():
        for report_id in report_ids:
            report = reports_by_id[report_id]
            phenomenon = _clean_text(report.get("phenomenon"))
            evidence_key = _phenomenon_evidence_key(prefix, phenomenon)
            classifications = _canonical_problem_types(phenomenon)
            locations = _explicit_occurrence_locations(phenomenon)
            for classification in classifications:
                problem_key = classification["key"]
                problem = problem_groups.setdefault(problem_key, {
                    "metric_key": classification["metric_key"],
                    "canonical_key": classification["key"],
                    "label": classification["label"],
                    "classification_basis": classification["classification_basis"],
                    "source_evidence_keys": set(),
                    "report_ids": set(),
                    "prefixes": set(),
                })
                if "recorded_text" in classification:
                    problem["recorded_text"] = classification["recorded_text"]
                problem["source_evidence_keys"].add(evidence_key)
                problem["report_ids"].add(report_id)
                problem["prefixes"].add(prefix)

            for location in locations:
                location_group = location_groups.setdefault(location["key"], {
                    "metric_key": f"location:{location['key']}",
                    "label": location["label"],
                    "classification_basis": (
                        "unlocated" if location["key"] == "unknown" else "explicit_keyword_v1"
                    ),
                    "source_evidence_keys": set(),
                    "report_ids": set(),
                    "prefixes": set(),
                })
                location_group["source_evidence_keys"].add(evidence_key)
                location_group["report_ids"].add(report_id)
                location_group["prefixes"].add(prefix)

            # A paired signal is intentionally stricter than either coverage
            # dimension by itself: both the server-owned canonical problem and
            # an explicit recorded location must come from this exact source
            # QualityReport row.  Unknown/unclassified phenomena and missing
            # locations never create a pair.  Problem-type totals above still
            # include every matching report, regardless of location presence.
            canonical_problems = [
                classification
                for classification in classifications
                if classification.get("classification_basis") == "canonical_alias_v1"
            ]
            explicit_locations = [
                location for location in locations if location.get("key") != "unknown"
            ]
            if len(canonical_problems) > 1 and len(explicit_locations) > 1:
                # Without clause-level source fields, a cross-product could
                # falsely turn e.g. "top burr / bottom scratch" into four
                # pairs.  Fail closed until deterministic phrase segmentation
                # is introduced.
                ambiguous_pair_report_ids.add(report_id)
                continue
            for classification in canonical_problems:
                for location in explicit_locations:
                    pair_key = (classification["key"], location["key"])
                    pair = problem_location_pair_groups.setdefault(pair_key, {
                        "metric_key": f"pair:{classification['key']}:{location['key']}",
                        "dimension": "problem_location_pair",
                        "problem_canonical_key": classification["key"],
                        "location_canonical_key": location["key"],
                        "problem_label": classification["label"],
                        "location_label": location["label"],
                        "label": {
                            "ko": f"{classification['label']['ko']} · {location['label']['ko']}",
                            "zh": f"{classification['label']['zh']} · {location['label']['zh']}",
                        },
                        "classification_basis": "canonical_problem_explicit_location_pair_v1",
                        "pair_basis": "same_quality_report_id",
                        "source_evidence_keys": set(),
                        "report_ids": set(),
                        "prefixes": set(),
                    })
                    pair["source_evidence_keys"].add(evidence_key)
                    pair["report_ids"].add(report_id)
                    pair["prefixes"].add(prefix)

    global_denominator_ids = set(reports_by_id)

    def metric_row(group: dict[str, Any]) -> dict[str, Any]:
        report_ids = set(group["report_ids"])
        prefixes = set(group["prefixes"])
        denominator_ids = global_denominator_ids
        dated_values = [
            _report_datetime(reports_by_id[report_id].get("report_dt"))
            for report_id in report_ids
            if report_id in reports_by_id
        ]
        dated_values = [value for value in dated_values if value is not None]
        evidence_count = len(report_ids)
        denominator_count = len(denominator_ids)
        row = {
            "metric_key": group["metric_key"],
            "label": dict(group["label"]),
            "classification_basis": group["classification_basis"],
            "source_evidence_keys": sorted(group["source_evidence_keys"]),
            "evidence_count": evidence_count,
            "repeat_status": "repeated" if evidence_count >= 2 else "single",
            "latest_report_dt": max(dated_values).isoformat() if dated_values else None,
            "all_history_denominator": denominator_count,
            "all_history_denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
            "all_history_share_pct": (
                round(evidence_count / denominator_count * 100, 1)
                if denominator_count
                else None
            ),
            "trend": _trend_metrics(
                report_ids,
                denominator_ids,
                report_dates,
                target_date=target_date,
            ),
            "impact_scope": _impact_scope(
                prefixes,
                report_ids,
                targets_by_prefix=targets_by_prefix,
                reports_by_id=reports_by_id,
            ),
        }
        if "canonical_key" in group:
            row["canonical_key"] = group["canonical_key"]
        if "recorded_text" in group:
            row["recorded_text"] = group["recorded_text"]
        for key in (
            "dimension",
            "problem_canonical_key",
            "location_canonical_key",
            "problem_label",
            "location_label",
            "pair_basis",
        ):
            if key in group:
                row[key] = deepcopy(group[key])
        return row

    problem_types = [metric_row(group) for group in problem_groups.values()]
    occurrence_locations = [metric_row(group) for group in location_groups.values()]
    problem_location_pairs = [
        metric_row(group) for group in problem_location_pair_groups.values()
    ]

    def sort_key(row: dict[str, Any]) -> tuple[Any, ...]:
        label = row.get("label") if isinstance(row.get("label"), dict) else {}
        latest = _report_datetime(row.get("latest_report_dt"))
        return (
            -int(row.get("evidence_count") or 0),
            -(latest.timestamp() if latest else 0),
            str(label.get("ko") or label.get("zh") or ""),
        )

    problem_types.sort(key=sort_key)
    problem_location_pairs.sort(key=sort_key)
    # Standalone locations are coverage diagnostics only, never AI candidates.
    # Keep the missing-location bucket last even when it has the largest count.
    occurrence_locations.sort(key=lambda row: (
        str(row.get("metric_key") or "") == "location:unknown",
        *sort_key(row),
    ))
    for index, row in enumerate(occurrence_locations, start=1):
        is_unknown = str(row.get("metric_key") or "") == "location:unknown"
        row.update({
            "dimension": "location_coverage",
            "analysis_role": "coverage_only",
            "ai_candidate": False,
            "is_unknown_location": is_unknown,
            "sort_state": "unknown_last" if is_unknown else "evidence_desc",
            "sort_rank": index,
        })
    all_report_datetimes = [
        _report_datetime(report.get("report_dt"))
        for report in reports_by_id.values()
    ]
    all_report_datetimes = [value for value in all_report_datetimes if value is not None]
    recent_end = target_date
    recent_start = recent_end - timedelta(days=QUALITY_TREND_WINDOW_DAYS - 1)
    previous_end = recent_start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=QUALITY_TREND_WINDOW_DAYS - 1)
    plan_items = [item for item in source.get("items") or [] if isinstance(item, dict)]
    return {
        "schema_version": QUALITY_DAILY_REPORT_SCHEMA_VERSION,
        "as_of_date": target_date.isoformat(),
        "calculated_at": datetime.now(_SHANGHAI_TZ).isoformat(),
        "history_coverage": "all_history",
        "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
        "trend_policy": {
            "window_days": QUALITY_TREND_WINDOW_DAYS,
            "recent_start": recent_start.isoformat(),
            "recent_end": recent_end.isoformat(),
            "previous_start": previous_start.isoformat(),
            "previous_end": previous_end.isoformat(),
            "min_window_denominator": QUALITY_TREND_MIN_WINDOW_DENOMINATOR,
            "min_combined_issue_count": QUALITY_TREND_MIN_COMBINED_ISSUE_COUNT,
            "repeat_min_evidence_count": 2,
            "increase_rule": "count_and_share_must_both_increase",
            "zero_denominator_policy": "insufficient_data",
            "small_sample_policy": "insufficient_data",
            "window_anchor": "selected_plan_date",
        },
        "coverage": {
            "plan_group_count": int(source.get("total_plan_count") or 0),
            "distinct_prefix_count": len(targets_by_prefix),
            "matched_report_count": len(reports_by_id),
            "without_history_count": int(source.get("without_history_count") or 0),
            "latest_report_dt": max(all_report_datetimes).isoformat() if all_report_datetimes else None,
            "model_names": sorted({
                _clean_text(value)
                for item in plan_items
                for value in item.get("model_names") or []
                if _clean_text(value)
            }),
            "part_nos": sorted({
                normalize_part_no(value)
                for item in plan_items
                for value in item.get("part_nos") or []
                if normalize_part_no(value)
            }),
            "problem_type_count": len(problem_types),
            "occurrence_location_count": len(occurrence_locations),
            "problem_location_pair_count": len(problem_location_pairs),
            "ambiguous_pair_report_count": len(ambiguous_pair_report_ids),
        },
        "problem_types": problem_types,
        "problem_location_pairs": problem_location_pairs,
        "occurrence_locations": occurrence_locations,
        "calculation_basis": {
            "counts_are_backend_authoritative": True,
            "report_ids_exposed": False,
            "images_exposed": False,
            "raw_disposition_exposed": False,
            "current_defect_claim_allowed": False,
            "root_cause_claim_allowed": False,
            "problem_type_taxonomy": QUALITY_PHENOMENON_TAXONOMY_VERSION,
            "unknown_problem_policy": "separate_unclassified_recorded_text_hash",
            "metric_denominator_basis": "unique_matching_reports_in_current_plan_prefixes",
            "location_rule": "explicit_recorded_keyword_else_unknown",
            "standalone_location_role": "coverage_only_not_ai_candidate",
            "problem_location_pair_rule": "same_quality_report_id_with_canonical_problem_and_explicit_location",
            "ambiguous_pair_policy": "skip_when_multiple_problems_and_multiple_locations",
            "problem_type_memberships_may_overlap": True,
            "problem_location_pair_memberships_may_overlap": True,
            "location_memberships_may_overlap": True,
            "trend_is_report_frequency_not_defect_rate": True,
            "zero_reports_do_not_prove_zero_defects": True,
        },
    }


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
            "plan_targets": item["plan_targets"],
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
        "source_evidence_hash": source["source_evidence_hash"],
        "source_evidence_last_changed_at": source["source_evidence_last_changed_at"],
        "summary_basis": {
            "match_basis": QUALITY_ATTENTION_MATCH_BASIS,
            "history_window": QUALITY_ATTENTION_HISTORY_WINDOW,
            "history_coverage": "all_history",
            "part_normalization": "uppercase_and_remove_whitespace_then_first_9_chars",
            "report_section": "all",
            "counts_are_backend_authoritative": True,
            "trend_and_scope_are_backend_authoritative": True,
            "llm_role": "grounded_key_selection_and_priority_order_only",
            "current_defect_claim_allowed": False,
            "root_cause_claim_allowed": False,
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
        "report_metrics": source["report_metrics"],
        "items": items,
        "evidence_catalog": [evidence_catalog[key] for key in sorted(evidence_catalog)],
    }
