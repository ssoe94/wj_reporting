from __future__ import annotations

from datetime import datetime
from typing import Optional

from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import FinishedGoodsTransactionSnapshot
from .serializers import FinishedGoodsTransactionSnapshotSerializer
from .services.finished_goods import capture_finished_goods_transactions


def _parse_iso_datetime(value: str) -> datetime:
    tz = timezone.get_default_timezone()
    dt = datetime.fromisoformat(value)
    if timezone.is_naive(dt):
        return timezone.make_aware(dt, tz)
    return dt.astimezone(tz)


def _parse_date(value: str):
    return datetime.strptime(value, '%Y-%m-%d').date()


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def finished_goods_transactions(request):
    """
    GET: 최신 완성품 입출고 스냅샷 조회
    POST: 즉시 스냅샷 생성 (수동 트리거)
    """
    if request.method == 'POST':
        payload = request.data or {}
        slot = payload.get('slot')
        date_str = payload.get('date')
        start_str = payload.get('start')
        end_str = payload.get('end')
        force = bool(payload.get('force', False))
        dry_run = bool(payload.get('dry_run', False))

        target_date = None
        if date_str:
            try:
                target_date = _parse_date(date_str)
            except ValueError:
                return Response(
                    {'error': 'Invalid date format. Expected YYYY-MM-DD.'},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        if (start_str and not end_str) or (end_str and not start_str):
            return Response(
                {'error': 'Both start and end must be provided together.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        start_dt = end_dt = None
        try:
            if start_str and end_str:
                start_dt = _parse_iso_datetime(start_str)
                end_dt = _parse_iso_datetime(end_str)
        except ValueError:
            return Response(
                {'error': 'Invalid datetime format. Use ISO-8601 string.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            result = capture_finished_goods_transactions(
                slot=slot,
                target_date=target_date,
                start_dt=start_dt,
                end_dt=end_dt,
                force=force,
                dry_run=dry_run,
            )
        except ValueError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        serializer = FinishedGoodsTransactionSnapshotSerializer(result.snapshot)
        return Response(
            {
                'snapshot': serializer.data,
                'raw_total': result.total_records,
                'filtered_total': result.filtered_records,
                'slot': result.slot,
            },
            status=status.HTTP_200_OK,
        )

    slot = request.GET.get('slot')
    date_str = request.GET.get('date')
    latest_per_slot = request.GET.get('latest_per_slot', '0') in ('1', 'true', 'True')
    limit_param = request.GET.get('limit')

    base_qs = FinishedGoodsTransactionSnapshot.objects.all()

    if slot in dict(FinishedGoodsTransactionSnapshot.SLOT_CHOICES):
        base_qs = base_qs.filter(slot=slot)

    if date_str:
        try:
            target_date = _parse_date(date_str)
        except ValueError:
            return Response(
                {'error': 'Invalid date format. Expected YYYY-MM-DD.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        base_qs = base_qs.filter(report_date=target_date)

    base_qs = base_qs.order_by('-scheduled_at')

    if latest_per_slot:
        snapshots = {}
        for slot_value, _label in FinishedGoodsTransactionSnapshot.SLOT_CHOICES:
            snapshot = base_qs.filter(slot=slot_value).first()
            if snapshot:
                try:
                    snapshots[slot_value] = FinishedGoodsTransactionSnapshotSerializer(snapshot).data
                except Exception as e:
                    # Log the error for backend debugging
                    import logging
                    logger = logging.getLogger(__name__)
                    logger.error(f"Failed to serialize snapshot ID {snapshot.id} for slot {slot_value}: {e}")
                    # Return an error object for this slot for frontend debugging
                    snapshots[slot_value] = {
                        'error': f'Serialization failed for snapshot ID {snapshot.id}',
                        'details': str(e),
                    }
            else:
                snapshots[slot_value] = None
        return Response({'snapshots': snapshots})

    try:
        limit = int(limit_param) if limit_param else 4
    except ValueError:
        limit = 4
    limit = max(1, min(limit, 50))

    serializer = FinishedGoodsTransactionSnapshotSerializer(base_qs[:limit], many=True)
    return Response({'snapshots': serializer.data})
