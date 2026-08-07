"""Persistent snapshot and usage-state helpers for the public mould board."""

from __future__ import annotations

import calendar
import copy
import re
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import MouldDataSnapshot, MouldUsageConfirmation


SHANGHAI = ZoneInfo('Asia/Shanghai')
BOARD_SNAPSHOT_KEY = 'mould-board:all:v1'
DETAIL_SNAPSHOT_PREFIX = 'mould-detail:v1:'
SHOT_MILESTONE_SIZE = 100_000
SNAPSHOT_MAX_AGE = timedelta(hours=1)
REFRESH_LEASE = timedelta(minutes=15)


def detail_snapshot_key(instance_id: str) -> str:
    return f'{DETAIL_SNAPSHOT_PREFIX}{instance_id}'


def parse_source_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    parsed = parse_datetime(str(value))
    if parsed is None:
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, SHANGHAI)
    return parsed


def snapshot_is_stale(snapshot: MouldDataSnapshot) -> bool:
    return snapshot.refreshed_at < timezone.now() - SNAPSHOT_MAX_AGE


def store_snapshot(
    *,
    snapshot_key: str,
    kind: str,
    payload: Mapping[str, Any],
    instance_id: str = '',
) -> MouldDataSnapshot:
    freshness = payload.get('data_freshness')
    source_latest_at = parse_source_datetime(
        freshness.get('source_latest_at') if isinstance(freshness, Mapping) else None
    )
    snapshot, _ = MouldDataSnapshot.objects.update_or_create(
        snapshot_key=snapshot_key,
        defaults={
            'kind': kind,
            'instance_id': instance_id,
            'payload': copy.deepcopy(dict(payload)),
            'source_latest_at': source_latest_at,
            'refresh_started_at': None,
            'last_error': '',
        },
    )
    return snapshot


def claim_refresh(snapshot_key: str) -> bool:
    """Claim a short DB-backed lease so web workers do not all refresh upstream."""

    cutoff = timezone.now() - REFRESH_LEASE
    with transaction.atomic():
        snapshot = (
            MouldDataSnapshot.objects.select_for_update()
            .filter(snapshot_key=snapshot_key)
            .first()
        )
        if snapshot is None:
            return True
        if snapshot.refresh_started_at and snapshot.refresh_started_at >= cutoff:
            return False
        snapshot.refresh_started_at = timezone.now()
        snapshot.save(update_fields=['refresh_started_at'])
        return True


def release_refresh(snapshot_key: str, error: str = '') -> None:
    MouldDataSnapshot.objects.filter(snapshot_key=snapshot_key).update(
        refresh_started_at=None,
        last_error=str(error or '')[:500],
    )


def _monthly_activity_date(row: Mapping[str, Any]) -> datetime | None:
    year = row.get('year')
    month = row.get('month')
    if not isinstance(year, int) or not isinstance(month, int):
        match = re.search(r'(?<!\d)(20\d{2})[-./年](0?[1-9]|1[0-2])', str(row.get('period') or ''))
        if not match:
            return None
        year, month = int(match.group(1)), int(match.group(2))
    if year < 2000 or not 1 <= month <= 12:
        return None
    day = calendar.monthrange(year, month)[1]
    return datetime(year, month, day, 23, 59, 59, tzinfo=SHANGHAI)


def last_production_at(production_history: Any) -> datetime | None:
    if not isinstance(production_history, Sequence) or isinstance(
        production_history, (str, bytes, bytearray)
    ):
        return None
    dates = [
        parsed
        for row in production_history
        if isinstance(row, Mapping)
        for parsed in [_monthly_activity_date(row)]
        if parsed is not None
    ]
    return max(dates) if dates else None


def _usage_state(
    *,
    current_output_amount: Any,
    production_history: Any,
    confirmed_milestones: Sequence[int],
    mounted: bool = False,
) -> dict[str, Any]:
    try:
        shot_count = max(0, int(float(current_output_amount)))
    except (TypeError, ValueError):
        shot_count = 0

    reached_milestone = (shot_count // SHOT_MILESTONE_SIZE) * SHOT_MILESTONE_SIZE
    confirmed = sorted(
        value for value in confirmed_milestones
        if isinstance(value, int) and value > 0 and value <= reached_milestone
    )
    confirmed_milestone = confirmed[-1] if confirmed else 0
    pending_milestone = (
        reached_milestone if reached_milestone > confirmed_milestone else None
    )

    activity_at = last_production_at(production_history)
    inactivity_months: int | None = None
    inactivity_tier = 'active' if mounted else 'unknown'
    if activity_at is not None:
        now = timezone.now().astimezone(SHANGHAI)
        inactivity_months = max(
            0,
            (now.year - activity_at.year) * 12 + now.month - activity_at.month,
        )
        if mounted:
            inactivity_tier = 'active'
        elif inactivity_months >= 12:
            inactivity_tier = 'twelve_months'
        elif inactivity_months >= 6:
            inactivity_tier = 'six_months'
        else:
            inactivity_tier = 'recent'

    return {
        'last_used_at': activity_at.isoformat() if activity_at else None,
        'last_used_source': 'blacklake.production_history.month' if activity_at else None,
        'inactivity_months': inactivity_months,
        'inactivity_tier': inactivity_tier,
        'shot_milestone': reached_milestone,
        'shot_milestone_level': reached_milestone // SHOT_MILESTONE_SIZE,
        'pending_milestone': pending_milestone,
        'confirmed_milestone': confirmed_milestone,
        'confirmation_required': pending_milestone is not None,
    }


def decorate_board_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(payload))
    moulds = result.get('moulds')
    if not isinstance(moulds, list):
        return result

    instance_ids = [
        str(row.get('instance_id') or '')
        for row in moulds
        if isinstance(row, Mapping) and row.get('instance_id')
    ]
    detail_payloads = {
        row.instance_id: row.payload
        for row in MouldDataSnapshot.objects.filter(
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id__in=instance_ids,
        ).only('instance_id', 'payload')
    }
    confirmations: dict[str, list[int]] = defaultdict(list)
    for row in MouldUsageConfirmation.objects.filter(
        mould_instance_id__in=instance_ids
    ).values('mould_instance_id', 'milestone_shots'):
        confirmations[str(row['mould_instance_id'])].append(row['milestone_shots'])

    for mould in moulds:
        if not isinstance(mould, dict):
            continue
        instance_id = str(mould.get('instance_id') or '')
        detail = detail_payloads.get(instance_id)
        production_history = (
            detail.get('production_history', [])
            if isinstance(detail, Mapping)
            else []
        )
        location = mould.get('location')
        mounted = isinstance(location, Mapping) and location.get('kind') == 'machine'
        mould.update(
            _usage_state(
                current_output_amount=mould.get('current_output_amount'),
                production_history=production_history,
                confirmed_milestones=confirmations.get(instance_id, []),
                mounted=mounted,
            )
        )
    return result


def decorate_detail_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(payload))
    mould = result.get('mould')
    if not isinstance(mould, dict):
        return result
    instance_id = str(mould.get('instance_id') or '')
    confirmed = list(
        MouldUsageConfirmation.objects.filter(mould_instance_id=instance_id)
        .values_list('milestone_shots', flat=True)
    )
    location = mould.get('location')
    mould.update(
        _usage_state(
            current_output_amount=mould.get('current_output_amount'),
            production_history=result.get('production_history', []),
            confirmed_milestones=confirmed,
            mounted=isinstance(location, Mapping) and location.get('kind') == 'machine',
        )
    )
    return result


def mark_snapshot_freshness(
    payload: Mapping[str, Any],
    snapshot: MouldDataSnapshot,
    *,
    refreshing: bool,
) -> dict[str, Any]:
    result = copy.deepcopy(dict(payload))
    freshness = result.get('data_freshness')
    freshness = dict(freshness) if isinstance(freshness, Mapping) else {}
    stale = snapshot_is_stale(snapshot)
    freshness.update(
        {
            'status': 'refreshing' if refreshing else ('stale' if stale else 'snapshot'),
            'fetched_at': snapshot.refreshed_at.isoformat(),
            'snapshot_at': snapshot.refreshed_at.isoformat(),
            'stale': stale,
        }
    )
    result['data_freshness'] = freshness
    return result
