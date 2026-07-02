from datetime import timedelta

import pytz
from django.core.management.base import BaseCommand
from django.utils import timezone

from injection.mes_service import mes_service


class Command(BaseCommand):
    help = "Build bucketed injection monitoring rollups from stored MES snapshots."

    def add_arguments(self, parser):
        parser.add_argument(
            "--hours",
            type=int,
            default=720,
            help="How many recent hours to rebuild. Defaults to 720 hours.",
        )
        parser.add_argument(
            "--bucket-minutes",
            type=int,
            nargs="+",
            default=[5, 30, 60],
            help="One or more bucket sizes to rebuild. Defaults to 5, 30, and 60.",
        )

    def handle(self, *args, **options):
        cst = pytz.timezone("Asia/Shanghai")
        hours = max(1, int(options["hours"]))
        bucket_minutes_values = sorted({max(1, int(value)) for value in options["bucket_minutes"]})
        end_time = timezone.now().astimezone(cst).replace(second=0, microsecond=0)
        start_time = end_time - timedelta(hours=hours)

        self.stdout.write(
            f"Building monitoring rollups for {start_time.isoformat()} ~ {end_time.isoformat()}"
        )
        for bucket_minutes in bucket_minutes_values:
            updated = mes_service.upsert_monitoring_rollups(
                start_time,
                end_time,
                bucket_minutes=bucket_minutes,
            )
            self.stdout.write(
                self.style.SUCCESS(f"{bucket_minutes}m rollups updated: {updated}")
            )
