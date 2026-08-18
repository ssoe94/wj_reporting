"""Deterministic duplicate candidates for Excel-imported quality incidents.

This module deliberately does not use an LLM.  It first blocks on the report
date plus an exact structured identifier (part number or model), then scores
auditable normalized fields.  A candidate is advisory until a reviewer makes
an explicit publish decision.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import defaultdict
from datetime import datetime, time, timedelta
from difflib import SequenceMatcher
from typing import Iterable
from zoneinfo import ZoneInfo

from django.db.models import Q

from .models import QualityImportRow, QualityReport


SHANGHAI = ZoneInfo('Asia/Shanghai')
DEFECT_TAXONOMY = {
    'color_difference': ('表面色差', '色差', '颜色差异', '변색', '색차', '컬러차이'),
    'scratch': ('划伤', '刮伤', '擦伤', '스크래치', '긁힘', '찰상'),
    'sink_mark': ('缩水', '缩水痕', '缩痕', '수축', '싱크', '싱크마크'),
    'whitening': ('发白', '拉白', '顶白', '백화', '하얗게', '화이트마크'),
    'contamination': ('脏污', '污渍', '油污', '异物', '오염', '이물', '얼룩'),
    'short_shot': ('缺料', '短射', '充填不足', '미성형', '충진부족', '숏샷'),
    'flash': ('毛边', '飞边', '披锋', '버', '플래시', '바리'),
    'black_spot': ('黑点', '黑斑', '흑점', '검은점'),
    'deformation': ('变形', '翘曲', '뒤틀림', '변형', '휨'),
    'bubble': ('气泡', '气孔', '기포', '에어'),
    'crack': ('裂纹', '开裂', '破裂', '크랙', '균열', '깨짐'),
    'mixed_color': ('混色', '杂色', '혼색'),
    'dimension': ('尺寸', '尺寸不良', '치수', '치수불량'),
}


def normalize_identifier(value: object) -> str:
    text = unicodedata.normalize('NFKC', str(value or '')).upper()
    return re.sub(r'[^0-9A-Z가-힣一-龥]+', '', text)


def normalize_text(value: object) -> str:
    text = unicodedata.normalize('NFKC', str(value or '')).lower()
    return re.sub(r'[^0-9a-z가-힣一-龥]+', '', text)


def canonical_defect(value: object) -> str:
    normalized = normalize_text(value)
    if not normalized:
        return ''
    for category, aliases in DEFECT_TAXONOMY.items():
        if any(normalize_text(alias) in normalized for alias in aliases):
            return category
    return ''


def _bigrams(value: str) -> set[str]:
    if len(value) < 2:
        return {value} if value else set()
    return {value[index:index + 2] for index in range(len(value) - 1)}


def text_similarity(left: object, right: object) -> float:
    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    sequence = SequenceMatcher(None, a, b, autojunk=False).ratio()
    a_pairs = _bigrams(a)
    b_pairs = _bigrams(b)
    union = a_pairs | b_pairs
    jaccard = len(a_pairs & b_pairs) / len(union) if union else 0.0
    return max(sequence, jaccard)


def _report_local_date(report: QualityReport):
    value = report.report_dt
    if value.tzinfo is None:
        value = value.replace(tzinfo=SHANGHAI)
    return value.astimezone(SHANGHAI).date()


def _source_kind(report: QualityReport) -> str:
    if report.excel_import_key:
        return 'excel'
    try:
        report.source_import_row
    except QualityImportRow.DoesNotExist:
        return 'manual'
    return 'excel'


def report_duplicate_version(report: QualityReport) -> str:
    """Return an opaque version for the exact evidence shown to a reviewer."""

    payload = {
        'id': report.pk,
        'updated_at': report.updated_at.isoformat() if report.updated_at else None,
        'report_dt': report.report_dt.isoformat() if report.report_dt else None,
        'section': report.section,
        'model': report.model,
        'part_no': report.part_no,
        'lot_qty': report.lot_qty,
        'inspection_qty': report.inspection_qty,
        'defect_qty': report.defect_qty,
        'defect_rate': report.defect_rate,
        'judgement': report.judgement,
        'phenomenon': report.phenomenon,
        'disposition': report.disposition,
        'action_result': report.action_result,
        'image1': report.image1,
        'image2': report.image2,
        'image3': report.image3,
        'image4': report.image4,
        'image5': report.image5,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(encoded.encode('utf-8')).hexdigest()


def _score(row: QualityImportRow, report: QualityReport) -> dict | None:
    if not row.report_date or _report_local_date(report) != row.report_date:
        return None

    row_part = normalize_identifier(row.part_no)
    report_part = normalize_identifier(report.part_no)
    row_model = normalize_identifier(row.model)
    report_model = normalize_identifier(report.model)
    part_match = bool(row_part and report_part and row_part == report_part)
    model_match = bool(row_model and report_model and row_model == report_model)
    if row_part and report_part and not part_match:
        return None
    if not (part_match or model_match):
        return None

    reasons = ['same_date']
    score = 12
    if part_match:
        score += 35
        reasons.append('same_part_no')
    if model_match:
        score += 16
        reasons.append('same_model')
    if row.section and report.section and row.section == report.section:
        score += 5
        reasons.append('same_section')

    row_category = canonical_defect(row.phenomenon)
    report_category = canonical_defect(report.phenomenon)
    category_match = bool(row_category and row_category == report_category)
    if category_match:
        score += 24
        reasons.append('same_defect_category')

    phenomenon_similarity = text_similarity(row.phenomenon, report.phenomenon)
    if phenomenon_similarity >= 0.92:
        score += 18
        reasons.append('very_similar_phenomenon')
    elif phenomenon_similarity >= 0.76:
        score += 13
        reasons.append('similar_phenomenon')
    elif phenomenon_similarity >= 0.58:
        score += 7
        reasons.append('related_phenomenon')

    if (
        row.defect_qty is not None
        and report.defect_qty is not None
        and row.defect_qty == report.defect_qty
    ):
        score += 5
        reasons.append('same_defect_quantity')
    if row.judgement and report.judgement and row.judgement.upper() == report.judgement.upper():
        score += 2
        reasons.append('same_judgement')
    disposition_similarity = text_similarity(row.disposition, report.disposition)
    if disposition_similarity >= 0.8:
        score += 5
        reasons.append('similar_disposition')

    strong_phenomenon = category_match or phenomenon_similarity >= 0.76
    if not strong_phenomenon:
        return None
    exact_phenomenon = bool(
        normalize_text(row.phenomenon)
        and normalize_text(row.phenomenon) == normalize_text(report.phenomenon)
    )
    if score >= 82 and part_match and exact_phenomenon and (model_match or row.defect_qty == report.defect_qty):
        level = 'confirmed'
    elif score >= 60:
        level = 'likely'
    else:
        return None

    source_kind = _source_kind(report)
    if source_kind == 'manual':
        # Manual records have no source business key or comparable image hash;
        # even an exact text match remains an advisory candidate.
        level = 'likely'
    return {
        'level': level,
        'score': min(score, 100),
        'report_id': report.pk,
        'version': report_duplicate_version(report),
        'source_kind': source_kind,
        'reasons': reasons,
        'allowed_actions': (
            ['link_existing', 'update_existing', 'separate']
            if source_kind == 'manual'
            else ['separate']
        ),
        'report': {
            'report_dt': report.report_dt.isoformat(),
            'report_date': _report_local_date(report).isoformat(),
            'section': report.section,
            'model': report.model,
            'part_no': report.part_no,
            'lot_qty': report.lot_qty,
            'inspection_qty': report.inspection_qty,
            'defect_qty': report.defect_qty,
            'defect_rate': report.defect_rate,
            'judgement': report.judgement,
            'phenomenon': report.phenomenon,
            'disposition': report.disposition,
            'action_result': report.action_result,
            'images': [
                value for value in (
                    report.image1, report.image2, report.image3,
                    report.image4, report.image5,
                )
                if value
            ],
        },
    }


def score_report_duplicate(row: QualityImportRow, report: QualityReport) -> dict | None:
    """Score one already-locked report using the public duplicate contract."""

    return _score(row, report)


def find_best_report_duplicates(rows: Iterable[QualityImportRow]) -> dict[int, dict]:
    rows = [
        row for row in rows
        if row.pk and row.report_date and (row.part_no or row.model)
        and row.review_status not in {
            QualityImportRow.ReviewStatus.UNCHANGED,
            QualityImportRow.ReviewStatus.PUBLISHED,
        }
    ]
    if not rows:
        return {}

    requested_dates = sorted({row.report_date for row in rows})
    requested_days = Q(pk__isnull=True)
    for requested_date in requested_dates:
        start = datetime.combine(requested_date, time.min, tzinfo=SHANGHAI)
        end = datetime.combine(requested_date + timedelta(days=1), time.min, tzinfo=SHANGHAI)
        requested_days |= Q(report_dt__gte=start, report_dt__lt=end)
    reports = list(
        QualityReport.objects.filter(requested_days)
        .select_related('source_import_row')
        .order_by('-updated_at', '-id')
    )
    by_date: dict[object, list[QualityReport]] = defaultdict(list)
    for report in reports:
        by_date[_report_local_date(report)].append(report)

    result: dict[int, dict] = {}
    for row in rows:
        candidates = []
        for report in by_date.get(row.report_date, []):
            if row.approved_report_id == report.pk:
                continue
            candidate = _score(row, report)
            if candidate:
                candidates.append(candidate)
        if candidates:
            result[row.pk] = sorted(
                candidates,
                key=lambda item: (
                    item['level'] == 'confirmed',
                    item['score'],
                    item['report_id'],
                ),
                reverse=True,
            )[0]
    return result


def find_best_report_duplicate(row: QualityImportRow) -> dict | None:
    return find_best_report_duplicates([row]).get(row.pk)
