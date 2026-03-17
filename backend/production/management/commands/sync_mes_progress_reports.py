from __future__ import annotations

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from production.mes_progress import (
    extract_equipment_name,
    extract_mes_material_name,
    extract_qty,
    fetch_all_progress_reports,
    get_business_date,
    normalize_equipment_key,
    normalize_mes_part_no,
    normalize_plan_type,
    parse_report_time,
)
from production.models import ProductionMesReportRecord


class Command(BaseCommand):
    help = 'Sync MES progress reports into ProductionMesReportRecord.'

    def add_arguments(self, parser):
        parser.add_argument('--mode', choices=['auto', 'initial', 'incremental'], default='auto')
        parser.add_argument('--initial-hours', type=int, default=24)
        parser.add_argument('--incremental-minutes', type=int, default=5)
        parser.add_argument('--dry-run', action='store_true')

    def handle(self, *args, **options):
        mode = options['mode']
        initial_hours = max(1, int(options['initial_hours']))
        incremental_minutes = max(1, int(options['incremental_minutes']))
        dry_run = bool(options['dry_run'])

        now = timezone.now().astimezone(timezone.get_default_timezone())
        has_existing = ProductionMesReportRecord.objects.exists()
        if mode == 'auto':
            mode = 'incremental' if has_existing else 'initial'

        if mode == 'initial':
            start_dt = now - timedelta(hours=initial_hours)
        else:
            start_dt = now - timedelta(minutes=incremental_minutes)

        report_time_from = int(start_dt.timestamp() * 1000)
        report_time_to = int(now.timestamp() * 1000)

        rows = fetch_all_progress_reports(
            report_time_from=report_time_from,
            report_time_to=report_time_to,
        )

        prepared = []
        skipped = 0
        for row in rows:
            report_time = parse_report_time(row.get('reportTime'))
            plan_type = normalize_plan_type(row.get('processCode'))
            equipment_name = extract_equipment_name(row)
            equipment_key = normalize_equipment_key(plan_type or '', equipment_name) if plan_type else ''
            part_no = normalize_mes_part_no(row)
            report_qty = extract_qty(row)
            detail_id = row.get('reportRecordDetailId') or row.get('id')

            if not detail_id or not report_time or not plan_type or not equipment_key or not part_no:
                skipped += 1
                continue

            prepared.append({
                'report_record_detail_id': int(detail_id),
                'report_record_id': row.get('reportRecordId'),
                'report_record_code': row.get('reportRecordCode') or '',
                'business_date': get_business_date(report_time),
                'plan_type': plan_type,
                'process_code': (row.get('processCode') or '').strip().upper(),
                'report_time': report_time,
                'equipment_name': equipment_name,
                'equipment_key': equipment_key,
                'part_no': part_no,
                'material_name': extract_mes_material_name(row),
                'report_qty': report_qty,
                'raw_payload': row,
            })

        created = 0
        updated = 0
        if not dry_run:
            with transaction.atomic():
                for payload in prepared:
                    _, was_created = ProductionMesReportRecord.objects.update_or_create(
                        report_record_detail_id=payload['report_record_detail_id'],
                        defaults=payload,
                    )
                    if was_created:
                        created += 1
                    else:
                        updated += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"[MES Progress Sync] mode={mode} range=({start_dt.isoformat()} -> {now.isoformat()}) "
                f"raw={len(rows)} prepared={len(prepared)} skipped={skipped} "
                f"created={created} updated={updated} dry_run={dry_run}"
            )
        )
