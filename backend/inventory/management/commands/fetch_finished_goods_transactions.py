from __future__ import annotations

import logging
from datetime import datetime

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from inventory.services.finished_goods import capture_finished_goods_transactions

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Fetch finished-goods warehouse transactions from MES and persist a snapshot.'

    def add_arguments(self, parser):
        parser.add_argument('--slot', choices=['morning', 'evening'], help='Capture slot (08:00 or 20:00).')
        parser.add_argument('--date', help='Target date for the slot (YYYY-MM-DD).')
        parser.add_argument('--start', help='Custom start datetime (ISO-8601).')
        parser.add_argument('--end', help='Custom end datetime (ISO-8601).')
        parser.add_argument('--force', action='store_true', help='Overwrite existing snapshot if present.')
        parser.add_argument('--dry-run', action='store_true', help='Fetch data without saving to the database.')

    def _parse_iso_datetime(self, value: str):
        tz = timezone.get_default_timezone()
        try:
            dt = datetime.fromisoformat(value)
        except ValueError as exc:
            raise CommandError(f'Invalid datetime format: {value}') from exc

        if timezone.is_naive(dt):
            return timezone.make_aware(dt, tz)
        return dt.astimezone(tz)

    def handle(self, *args, **options):
        slot = options.get('slot')
        date_str = options.get('date')
        start_str = options.get('start')
        end_str = options.get('end')
        force = options.get('force', False)
        dry_run = options.get('dry_run', False)

        target_date = None
        if date_str:
            try:
                target_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            except ValueError as exc:
                raise CommandError(f'Invalid date format: {date_str}') from exc

        start_dt = end_dt = None
        if start_str or end_str:
            if not (start_str and end_str):
                raise CommandError('Both --start and --end must be provided together.')
            start_dt = self._parse_iso_datetime(start_str)
            end_dt = self._parse_iso_datetime(end_str)

        capture_logger = logger if not dry_run else None

        result = capture_finished_goods_transactions(
            slot=slot,
            target_date=target_date,
            start_dt=start_dt,
            end_dt=end_dt,
            force=force,
            dry_run=dry_run,
            logger=capture_logger,
        )

        snapshot = result.snapshot

        message = (
            f"[FinishedGoods] slot={result.slot} range=({result.start} -> {result.end}) "
            f"records={snapshot.record_count} raw={result.total_records} filtered={result.filtered_records}"
        )
        self.stdout.write(self.style.SUCCESS(message))

        if not dry_run:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Snapshot saved (id={snapshot.id}, report_date={snapshot.report_date}, "
                    f"total_in={snapshot.total_in}, total_out={snapshot.total_out})"
                )
            )
