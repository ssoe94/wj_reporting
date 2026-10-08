from django.core.management.base import BaseCommand, CommandError
from mes_oauth.vault import rotate_actor_key, VaultBlocked


class Command(BaseCommand):
    help = 'Explicitly re-encrypt one actor with the configured active key. Never issues a key/token.'

    def add_arguments(self, parser):
        parser.add_argument('--actor-id', type=int, required=True)
        parser.add_argument('--apply', action='store_true')

    def handle(self, *args, **options):
        if options['actor_id'] < 1:
            raise CommandError('invalid_actor')
        if not options['apply']:
            self.stdout.write('applied=False')
            return
        try:
            changed = rotate_actor_key(options['actor_id'])
        except VaultBlocked:
            raise CommandError('rotation_unavailable') from None
        self.stdout.write(f'rotated={changed}')
