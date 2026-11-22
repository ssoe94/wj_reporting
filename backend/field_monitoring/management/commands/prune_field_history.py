import json

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from ...retention import DEFAULT_LIMIT, MAX_LIMIT, prune_field_history


class Command(BaseCommand):
    help = 'Preview or apply a single bounded two-year field history retention batch.'

    def add_arguments(self, parser):
        action = parser.add_mutually_exclusive_group()
        action.add_argument('--dry-run', action='store_true', help='Preview without writes (default).')
        action.add_argument('--apply', action='store_true', help='Delete the selected event rows.')
        parser.add_argument('--limit', type=int, default=DEFAULT_LIMIT, help=f'Maximum total rows: {MAX_LIMIT}.')

    def handle(self, *args, **options):
        limit = options['limit']
        if not 1 <= limit <= MAX_LIMIT:
            raise CommandError(f'--limit must be between 1 and {MAX_LIMIT}')
        result = prune_field_history(timezone.now(), limit=limit, dry_run=not options['apply'])
        self.stdout.write(json.dumps(result, sort_keys=True))
