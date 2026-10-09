from django.core.management.base import BaseCommand
from mes_oauth.vault import purge_expired


class Command(BaseCommand):
    help = 'Count expired MES ciphertext rows; --apply clears a bounded batch. No provider call.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')

    def handle(self, *args, **options):
        count = purge_expired(apply=options['apply'])
        self.stdout.write(f'expired_batch_count={count} applied={bool(options["apply"])}')
