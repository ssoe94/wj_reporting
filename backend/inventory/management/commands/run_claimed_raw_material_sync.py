"""Execute a DB-claimed raw-material sync in a detached process."""

from django.core.management.base import BaseCommand, CommandError

from inventory.models import RawMaterialSyncState
from inventory.services.raw_material_sync import execute_claimed_raw_material_sync


class Command(BaseCommand):
    help = "Execute an already claimed raw-material MES synchronization"

    def add_arguments(self, parser):
        parser.add_argument(
            "--trigger",
            required=True,
            choices=(
                RawMaterialSyncState.TRIGGER_MANUAL,
                RawMaterialSyncState.TRIGGER_DAILY,
            ),
        )
        parser.add_argument("--claimed-started-at", required=True)

    def handle(self, *args, **options):
        result = execute_claimed_raw_material_sync(
            trigger=options["trigger"],
            claimed_started_at=options["claimed_started_at"],
        )
        if result["status"] == RawMaterialSyncState.STATUS_FAILED:
            raise CommandError(result["message"])
        self.stdout.write(self.style.SUCCESS(result["message"]))
