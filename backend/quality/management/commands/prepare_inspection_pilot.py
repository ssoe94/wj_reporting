"""Explicit server-side preparation; no MES writes, tokens or flag changes."""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from quality.inspection_live_adapter import _pairs
from quality.inspection_pilot_preparation import prepare_pilot


class Command(BaseCommand):
    help = 'Validate one QC binding manifest; --apply stores local intent only.'

    def add_arguments(self, parser):
        parser.add_argument('--manifest', required=True)
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--allow-single-actor-test', action='store_true')

    def handle(self, *args, **options):
        try:
            path = Path(options['manifest'])
            if path.stat().st_size > 65536:
                raise ValueError()
            manifest = json.loads(path.read_text(), object_pairs_hook=_pairs,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            result = prepare_pilot(manifest, apply=options['apply'],
                                  allow_single_actor_test=options['allow_single_actor_test'])
        except Exception:
            raise CommandError('inspection_pilot_preparation_blocked') from None
        self.stdout.write(json.dumps(result, sort_keys=True))
