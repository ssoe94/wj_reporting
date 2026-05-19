from __future__ import annotations

from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from django.utils.dateparse import parse_date

from production.machining_reconciliation import reconcile_manual_reports


class Command(BaseCommand):
    help = "Match machining manual supplement reports with later MES progress reports."

    def add_arguments(self, parser):
        parser.add_argument("--from-date", dest="from_date", help="Start credit business date, YYYY-MM-DD.")
        parser.add_argument("--to-date", dest="to_date", help="End MES business date window, YYYY-MM-DD.")

    def handle(self, *args, **options):
        from_date = parse_date(options.get("from_date") or "")
        if not from_date:
            from_date = timezone.localdate()
        to_date = parse_date(options.get("to_date") or "")
        if not to_date:
            to_date = from_date + timedelta(days=2)
        if to_date < from_date:
            raise CommandError("--to-date must be on or after --from-date.")

        result = reconcile_manual_reports(from_date, to_date)
        self.stdout.write(self.style.SUCCESS(
            f"matched={result['matched']} partial={result['partial']} from={from_date} to={to_date}"
        ))
