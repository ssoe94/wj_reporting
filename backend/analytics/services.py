from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Any

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_date

from production.ai_context import build_calculation_basis, build_process_summary, build_used_data
from production.ai_retrievers import get_daily_production_context
from production.ai_metrics import DELAY_THRESHOLD_PERCENTAGE_POINT

from .models import (
    FactExceptionEvent,
    MartEquipmentDailyProgress,
    MartPartDailyProgress,
    MartProductionDailyProgress,
)


def parse_business_date(value: str | date | None) -> date:
    if isinstance(value, date):
        return value
    parsed = parse_date(str(value or ''))
    if not parsed:
        raise ValueError('date must use YYYY-MM-DD.')
    return parsed


def json_safe(value: Any) -> Any:
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def iso_or_none(value: Any) -> str | None:
    if not value:
        return None
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    return str(value)


def safe_int(value: Any) -> int:
    try:
        return int(round(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def safe_float(value: Any) -> float:
    try:
        return round(float(value or 0), 1)
    except (TypeError, ValueError):
        return 0.0


def _source_latest_for_process(process: str, process_context: dict[str, Any]) -> Any:
    if process == 'injection':
        return process_context.get('latest_mes_time') or process_context.get('last_plan_updated_at')
    return process_context.get('latest_report_time') or process_context.get('last_plan_updated_at')


def _source_row_counts(process: str, process_context: dict[str, Any]) -> dict[str, int]:
    if process == 'injection':
        return {
            'plan_row_count': int(process_context.get('plan_row_count') or 0),
            'monitoring_row_count': int(process_context.get('monitoring_row_count') or 0),
        }
    return {
        'plan_row_count': int(process_context.get('plan_row_count') or 0),
        'mes_row_count': int(process_context.get('mes_row_count') or 0),
    }


def _warnings_for_process(process: str, process_context: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    if safe_int(process_context.get('planned_qty')) <= 0:
        warnings.append(f'{process}_plan_missing')
    if process == 'injection' and safe_int(process_context.get('planned_qty')) > 0:
        if not process_context.get('latest_mes_time'):
            warnings.append('injection_mes_data_missing')
        if safe_int(process_context.get('monitoring_row_count')) <= 0:
            warnings.append('injection_monitoring_rows_missing')
    if process == 'machining' and safe_int(process_context.get('planned_qty')) > 0:
        if safe_int(process_context.get('mes_row_count')) <= 0:
            warnings.append('machining_actual_missing')
    return warnings


def _status_for_part(planned_qty: int, actual_qty: int) -> str:
    if planned_qty <= 0 and actual_qty > 0:
        return 'mes_only'
    if planned_qty > 0 and actual_qty <= 0:
        return 'pending'
    if planned_qty > 0 and actual_qty >= planned_qty:
        return 'completed'
    if actual_qty > 0:
        return 'in_progress'
    return 'pending'


def _build_daily_records(context: dict[str, Any], language: str) -> list[dict[str, Any]]:
    records = []
    used_data = [item.to_dict() for item in build_used_data(context)]
    calculation_basis = build_calculation_basis(language)

    for process in ['injection', 'machining']:
        process_context = context[process]
        time_progress_rate = process_context.get('time_progress_rate') if process == 'injection' else None
        summary = build_process_summary(process_context, time_progress_rate).to_dict()
        source_latest_at = _source_latest_for_process(process, process_context)
        records.append({
            'business_date': context['business_date'],
            'process': process,
            'range_start': context['range_start'],
            'range_end': context['range_end'],
            'reference_time': context.get('reference_time'),
            'source_latest_at': source_latest_at,
            'source_latest_at_iso': iso_or_none(source_latest_at),
            'source_row_counts': _source_row_counts(process, process_context),
            'used_data': used_data,
            'calculation_basis': calculation_basis,
            'warnings': _warnings_for_process(process, process_context),
            **summary,
        })
    return records


def _build_injection_equipment_and_parts(context: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    equipment_records = []
    part_records = []
    for row in context['injection'].get('machine_rows', []):
        equipment_key = str(row.get('machine_number') or '')
        equipment_label = row.get('machine') or row.get('machine_name') or equipment_key
        equipment_records.append({
            'business_date': context['business_date'],
            'process': 'injection',
            'equipment_key': equipment_key,
            'equipment_label': equipment_label,
            'equipment_name': row.get('machine_name') or equipment_label,
            'planned_qty': safe_int(row.get('planned_qty')),
            'actual_qty': safe_int(row.get('actual_qty')),
            'gap_qty': safe_int(row.get('gap_qty')),
            'progress_rate': safe_float(row.get('progress_rate')),
            'recent_60m_shots': safe_int(row.get('recent_60m_shots')),
            'recent_60m_avg_ct_sec': row.get('recent_60m_avg_ct_sec'),
            'is_running': bool(row.get('is_running')),
            'completed_count': safe_int(row.get('completed_count')),
            'in_progress_count': safe_int(row.get('in_progress_count')),
            'pending_count': safe_int(row.get('pending_count')),
            'source_payload': json_safe(row),
        })
        for part in row.get('parts') or []:
            part_records.append({
                'business_date': context['business_date'],
                'process': 'injection',
                'equipment_key': equipment_key,
                'equipment_label': equipment_label,
                'part_no': (part.get('part_no') or '').strip().upper() or '-',
                'model_name': part.get('model_name') or '',
                'lot_no': '' if part.get('lot_no') in [None, '-'] else str(part.get('lot_no') or ''),
                'sequence': safe_int(part.get('sequence')),
                'planned_qty': safe_int(part.get('planned_qty')),
                'actual_qty': safe_int(part.get('estimated_qty')),
                'gap_qty': safe_int(part.get('gap_qty')),
                'progress_rate': safe_float(part.get('progress_rate')),
                'cavity': max(1, safe_int(part.get('cavity'))),
                'status': part.get('status') or _status_for_part(
                    safe_int(part.get('planned_qty')),
                    safe_int(part.get('estimated_qty')),
                ),
                'source_payload': json_safe(part),
            })
    return equipment_records, part_records


def _build_machining_equipment_and_parts(context: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    grouped: dict[str, dict[str, Any]] = {}
    part_records = []
    sequence_by_equipment: dict[str, int] = defaultdict(int)

    for row in context['machining'].get('rows', []):
        equipment_key = str(row.get('equipment_key') or '')
        equipment_label = row.get('equipment_label') or row.get('equipment_name') or equipment_key
        group = grouped.setdefault(equipment_key, {
            'business_date': context['business_date'],
            'process': 'machining',
            'equipment_key': equipment_key,
            'equipment_label': equipment_label,
            'equipment_name': row.get('equipment_name') or equipment_label,
            'planned_qty': 0,
            'actual_qty': 0,
            'gap_qty': 0,
            'progress_rate': 0,
            'recent_60m_shots': 0,
            'recent_60m_avg_ct_sec': None,
            'is_running': False,
            'completed_count': 0,
            'in_progress_count': 0,
            'pending_count': 0,
            'source_payload': {'rows': []},
        })

        planned_qty = safe_int(row.get('planned_qty'))
        actual_qty = safe_int(row.get('actual_qty'))
        part_status = _status_for_part(planned_qty, actual_qty)
        group['planned_qty'] += planned_qty
        group['actual_qty'] += actual_qty
        group['gap_qty'] += actual_qty - planned_qty
        group['is_running'] = group['is_running'] or actual_qty > 0
        group['completed_count'] += 1 if part_status == 'completed' else 0
        group['in_progress_count'] += 1 if part_status == 'in_progress' else 0
        group['pending_count'] += 1 if part_status == 'pending' else 0
        group['source_payload']['rows'].append(json_safe(row))

        sequence_by_equipment[equipment_key] += 1
        part_records.append({
            'business_date': context['business_date'],
            'process': 'machining',
            'equipment_key': equipment_key,
            'equipment_label': equipment_label,
            'part_no': (row.get('part_no') or '').strip().upper() or '-',
            'model_name': row.get('model_name') or '',
            'lot_no': '',
            'sequence': sequence_by_equipment[equipment_key],
            'planned_qty': planned_qty,
            'actual_qty': actual_qty,
            'gap_qty': actual_qty - planned_qty,
            'progress_rate': safe_float(row.get('progress_rate')),
            'cavity': 1,
            'status': part_status,
            'source_payload': json_safe(row),
        })

    equipment_records = []
    for group in grouped.values():
        group['progress_rate'] = round((group['actual_qty'] / group['planned_qty']) * 100, 1) if group['planned_qty'] > 0 else 0
        equipment_records.append(group)
    return equipment_records, part_records


def _exception_payload(
    *,
    business_date: date,
    process: str,
    exception_type: str,
    equipment_key: str = '',
    equipment_label: str = '',
    part_no: str = '',
    title: str,
    detail: str = '',
    severity: str = 'warning',
    source_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_key = ':'.join([
        'production_mart',
        business_date.isoformat(),
        process,
        exception_type,
        equipment_key or '-',
        part_no or '-',
    ])
    return {
        'source': 'production_mart',
        'source_key': source_key,
        'business_date': business_date,
        'process': process,
        'exception_type': exception_type,
        'severity': severity,
        'equipment_key': equipment_key,
        'equipment_label': equipment_label,
        'part_no': part_no,
        'title': title,
        'detail': detail,
        'source_payload': json_safe(source_payload or {}),
    }


def _build_exception_records(
    context: dict[str, Any],
    daily_records: list[dict[str, Any]],
    equipment_records: list[dict[str, Any]],
    part_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    records = []
    business_date = context['business_date']
    injection_daily = next((row for row in daily_records if row['process'] == 'injection'), None)
    injection_time_progress = injection_daily.get('time_progress_rate') if injection_daily else None

    for row in equipment_records:
        process = row['process']
        planned_qty = safe_int(row.get('planned_qty'))
        actual_qty = safe_int(row.get('actual_qty'))
        progress_rate = safe_float(row.get('progress_rate'))
        equipment_key = row.get('equipment_key') or ''
        equipment_label = row.get('equipment_label') or equipment_key

        if process == 'injection' and planned_qty > 0 and actual_qty <= 0:
            records.append(_exception_payload(
                business_date=business_date,
                process=process,
                exception_type='missing_mes_data',
                equipment_key=equipment_key,
                equipment_label=equipment_label,
                title=f'{equipment_label} MES 실적 없음',
                detail='계획은 있지만 기준일 MES 생산량이 없습니다.',
                source_payload=row,
            ))

        is_behind_time = (
            injection_time_progress is not None
            and process == 'injection'
            and progress_rate < float(injection_time_progress) - DELAY_THRESHOLD_PERCENTAGE_POINT
        )
        is_incomplete_past_or_machining = process == 'machining' and planned_qty > 0 and actual_qty < planned_qty
        if planned_qty > 0 and actual_qty < planned_qty and (is_behind_time or is_incomplete_past_or_machining):
            records.append(_exception_payload(
                business_date=business_date,
                process=process,
                exception_type='production_behind_schedule',
                equipment_key=equipment_key,
                equipment_label=equipment_label,
                title=f'{equipment_label} 생산 지연',
                detail=f'계획 {planned_qty:,}개 대비 실적 {actual_qty:,}개입니다.',
                source_payload=row,
            ))

        if planned_qty > 0 and actual_qty > planned_qty:
            records.append(_exception_payload(
                business_date=business_date,
                process=process,
                exception_type='overproduction',
                equipment_key=equipment_key,
                equipment_label=equipment_label,
                title=f'{equipment_label} 계획 초과 생산',
                detail=f'계획 {planned_qty:,}개 대비 실적 {actual_qty:,}개입니다.',
                severity='info',
                source_payload=row,
            ))

    for row in part_records:
        process = row['process']
        planned_qty = safe_int(row.get('planned_qty'))
        actual_qty = safe_int(row.get('actual_qty'))
        equipment_key = row.get('equipment_key') or ''
        equipment_label = row.get('equipment_label') or equipment_key
        part_no = row.get('part_no') or ''

        if planned_qty > 0 and actual_qty <= 0:
            records.append(_exception_payload(
                business_date=business_date,
                process=process,
                exception_type='plan_only',
                equipment_key=equipment_key,
                equipment_label=equipment_label,
                part_no=part_no,
                title=f'{equipment_label} {part_no} 계획만 있음',
                detail='계획은 있지만 실적이 아직 없습니다.',
                source_payload=row,
            ))
        if planned_qty <= 0 and actual_qty > 0:
            records.append(_exception_payload(
                business_date=business_date,
                process=process,
                exception_type='mes_only',
                equipment_key=equipment_key,
                equipment_label=equipment_label,
                part_no=part_no,
                title=f'{equipment_label} {part_no} 계획 없는 실적',
                detail='MES 실적은 있지만 매칭되는 생산 계획이 없습니다.',
                source_payload=row,
            ))

    seen = set()
    deduped = []
    for record in records:
        if record['source_key'] in seen:
            continue
        seen.add(record['source_key'])
        deduped.append(record)
    return deduped


def build_production_progress_snapshot(target_date: date, language: str = 'ko') -> dict[str, Any]:
    context = get_daily_production_context(target_date)
    daily_records = _build_daily_records(context, language)
    injection_equipment, injection_parts = _build_injection_equipment_and_parts(context)
    machining_equipment, machining_parts = _build_machining_equipment_and_parts(context)
    equipment_records = injection_equipment + machining_equipment
    part_records = injection_parts + machining_parts
    exception_records = _build_exception_records(context, daily_records, equipment_records, part_records)
    source_latest_values = [row.get('source_latest_at') for row in daily_records if row.get('source_latest_at')]

    return {
        'scope': {
            'business_date': context['business_date'].isoformat(),
            'range_start': iso_or_none(context['range_start']),
            'range_end': iso_or_none(context['range_end']),
            'reference_time': iso_or_none(context.get('reference_time')),
            'processes': ['injection', 'machining'],
        },
        'freshness': {
            'source_latest_at': iso_or_none(max(source_latest_values) if source_latest_values else None),
            'mart_generated_at': None,
            'is_stale': False,
            'is_persisted': False,
        },
        'used_data': daily_records[0]['used_data'] if daily_records else [],
        'calculation_basis': daily_records[0]['calculation_basis'] if daily_records else [],
        'warnings': sorted({warning for row in daily_records for warning in row.get('warnings', [])}),
        'daily': daily_records,
        'equipment': equipment_records,
        'parts': part_records,
        'exceptions': exception_records,
    }


def _upsert_exception(record: dict[str, Any], now) -> FactExceptionEvent:
    event, created = FactExceptionEvent.objects.get_or_create(
        source_key=record['source_key'],
        defaults={
            **record,
            'status': 'open',
            'detected_at': now,
        },
    )
    if created:
        return event

    for field in [
        'business_date',
        'process',
        'exception_type',
        'severity',
        'equipment_key',
        'equipment_label',
        'part_no',
        'title',
        'detail',
        'source_payload',
    ]:
        setattr(event, field, record[field])
    if event.status in ['resolved', 'ignored']:
        event.status = 'open'
        event.resolved_at = None
        event.detected_at = now
    event.save()
    return event


@transaction.atomic
def refresh_production_marts(target_date: date, language: str = 'ko') -> dict[str, Any]:
    snapshot = build_production_progress_snapshot(target_date, language=language)
    business_date = parse_business_date(snapshot['scope']['business_date'])
    now = timezone.now()

    for record in snapshot['daily']:
        MartProductionDailyProgress.objects.update_or_create(
            business_date=business_date,
            process=record['process'],
            defaults={
                'range_start': record['range_start'],
                'range_end': record['range_end'],
                'reference_time': record.get('reference_time'),
                'source_latest_at': record.get('source_latest_at'),
                'planned_qty': safe_int(record.get('planned_qty')),
                'actual_qty': safe_int(record.get('actual_qty')),
                'gap_qty': safe_int(record.get('gap_qty')),
                'progress_rate': safe_float(record.get('progress_rate')),
                'time_progress_rate': record.get('time_progress_rate'),
                'status': record.get('status') or 'no_plan',
                'active_equipment_count': safe_int(record.get('active_equipment_count')),
                'running_equipment_count': safe_int(record.get('running_equipment_count')),
                'total_equipment_count': safe_int(record.get('total_equipment_count')),
                'source_row_counts': record.get('source_row_counts') or {},
                'used_data': record.get('used_data') or [],
                'calculation_basis': record.get('calculation_basis') or [],
                'warnings': record.get('warnings') or [],
            },
        )

    MartEquipmentDailyProgress.objects.filter(business_date=business_date).delete()
    MartEquipmentDailyProgress.objects.bulk_create([
        MartEquipmentDailyProgress(**record)
        for record in snapshot['equipment']
    ])

    MartPartDailyProgress.objects.filter(business_date=business_date).delete()
    MartPartDailyProgress.objects.bulk_create([
        MartPartDailyProgress(**record)
        for record in snapshot['parts']
    ])

    generated_exception_keys = []
    for record in snapshot['exceptions']:
        event = _upsert_exception(record, now)
        generated_exception_keys.append(event.source_key)

    stale_events = FactExceptionEvent.objects.filter(
        business_date=business_date,
        source='production_mart',
        status__in=['open', 'acknowledged'],
    )
    if generated_exception_keys:
        stale_events = stale_events.exclude(source_key__in=generated_exception_keys)
    stale_events.update(status='resolved', resolved_at=now)

    return get_saved_production_progress_payload(business_date)


def _serialize_daily(row: MartProductionDailyProgress) -> dict[str, Any]:
    return {
        'business_date': row.business_date.isoformat(),
        'process': row.process,
        'range_start': row.range_start.isoformat(),
        'range_end': row.range_end.isoformat(),
        'reference_time': iso_or_none(row.reference_time),
        'source_latest_at': iso_or_none(row.source_latest_at),
        'planned_qty': row.planned_qty,
        'actual_qty': row.actual_qty,
        'gap_qty': row.gap_qty,
        'progress_rate': row.progress_rate,
        'time_progress_rate': row.time_progress_rate,
        'status': row.status,
        'active_equipment_count': row.active_equipment_count,
        'running_equipment_count': row.running_equipment_count,
        'total_equipment_count': row.total_equipment_count,
        'source_row_counts': row.source_row_counts,
        'warnings': row.warnings,
        'generated_at': row.generated_at.isoformat(),
    }


def _serialize_equipment(row: MartEquipmentDailyProgress) -> dict[str, Any]:
    return {
        'business_date': row.business_date.isoformat(),
        'process': row.process,
        'equipment_key': row.equipment_key,
        'equipment_label': row.equipment_label,
        'equipment_name': row.equipment_name,
        'planned_qty': row.planned_qty,
        'actual_qty': row.actual_qty,
        'gap_qty': row.gap_qty,
        'progress_rate': row.progress_rate,
        'recent_60m_shots': row.recent_60m_shots,
        'recent_60m_avg_ct_sec': row.recent_60m_avg_ct_sec,
        'is_running': row.is_running,
        'completed_count': row.completed_count,
        'in_progress_count': row.in_progress_count,
        'pending_count': row.pending_count,
    }


def _serialize_part(row: MartPartDailyProgress) -> dict[str, Any]:
    return {
        'business_date': row.business_date.isoformat(),
        'process': row.process,
        'equipment_key': row.equipment_key,
        'equipment_label': row.equipment_label,
        'part_no': row.part_no,
        'model_name': row.model_name,
        'lot_no': row.lot_no,
        'sequence': row.sequence,
        'planned_qty': row.planned_qty,
        'actual_qty': row.actual_qty,
        'gap_qty': row.gap_qty,
        'progress_rate': row.progress_rate,
        'cavity': row.cavity,
        'status': row.status,
    }


def _serialize_exception(row: FactExceptionEvent) -> dict[str, Any]:
    return {
        'id': row.id,
        'source_key': row.source_key,
        'business_date': row.business_date.isoformat(),
        'process': row.process,
        'exception_type': row.exception_type,
        'severity': row.severity,
        'status': row.status,
        'equipment_key': row.equipment_key,
        'equipment_label': row.equipment_label,
        'part_no': row.part_no,
        'title': row.title,
        'detail': row.detail,
        'detected_at': row.detected_at.isoformat(),
        'resolved_at': iso_or_none(row.resolved_at),
    }


def get_saved_production_progress_payload(target_date: date) -> dict[str, Any] | None:
    business_date = parse_business_date(target_date)
    daily_rows = list(MartProductionDailyProgress.objects.filter(business_date=business_date).order_by('process'))
    if not daily_rows:
        return None

    latest_generated_at = max(row.generated_at for row in daily_rows)
    source_latest_values = [row.source_latest_at for row in daily_rows if row.source_latest_at]
    all_warnings = sorted({warning for row in daily_rows for warning in row.warnings})

    return {
        'scope': {
            'business_date': business_date.isoformat(),
            'range_start': daily_rows[0].range_start.isoformat(),
            'range_end': daily_rows[0].range_end.isoformat(),
            'reference_time': iso_or_none(daily_rows[0].reference_time),
            'processes': ['injection', 'machining'],
        },
        'freshness': {
            'source_latest_at': iso_or_none(max(source_latest_values) if source_latest_values else None),
            'mart_generated_at': latest_generated_at.isoformat(),
            'is_stale': False,
            'is_persisted': True,
        },
        'used_data': daily_rows[0].used_data,
        'calculation_basis': daily_rows[0].calculation_basis,
        'warnings': all_warnings,
        'daily': [_serialize_daily(row) for row in daily_rows],
        'equipment': [
            _serialize_equipment(row)
            for row in MartEquipmentDailyProgress.objects.filter(business_date=business_date).order_by('process', 'equipment_key')
        ],
        'parts': [
            _serialize_part(row)
            for row in MartPartDailyProgress.objects.filter(business_date=business_date).order_by('process', 'equipment_key', 'sequence', 'part_no')
        ],
        'exceptions': [
            _serialize_exception(row)
            for row in FactExceptionEvent.objects.filter(business_date=business_date).order_by('status', 'severity', 'process', 'equipment_key', 'part_no')
        ],
    }


def get_or_build_production_progress_payload(target_date: date, language: str = 'ko') -> dict[str, Any]:
    saved = get_saved_production_progress_payload(target_date)
    if saved:
        return saved
    snapshot = build_production_progress_snapshot(target_date, language=language)
    snapshot['warnings'] = sorted(set(snapshot.get('warnings', [])) | {'analytics_mart_missing_computed_live'})
    return json_safe(snapshot)
