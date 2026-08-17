import signal
import threading

from django.core.management.base import BaseCommand, CommandError

from quality.excel_import import (
    process_quality_import_batch,
    recover_stale_quality_imports,
)


class Command(BaseCommand):
    help = (
        'Consume the durable quality-import DB queue outside Gunicorn. '
        'Use --once [--limit N] for a scheduled worker or --watch for a background worker.'
    )

    def add_arguments(self, parser):
        mode = parser.add_mutually_exclusive_group()
        mode.add_argument('--once', action='store_true', help='Process available jobs and exit (default).')
        mode.add_argument('--watch', action='store_true', help='Continuously poll the DB queue.')
        parser.add_argument('--poll-seconds', type=float, default=5.0)
        parser.add_argument('--limit', type=int, default=1)
        parser.add_argument('--batch-id', type=int)

    def handle(self, *args, **options):
        stop = threading.Event()
        previous_handlers = {}

        def request_stop(signum, frame):
            stop.set()

        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, request_stop)

        watch = bool(options.get('watch'))
        poll_seconds = min(300.0, max(0.25, float(options.get('poll_seconds') or 5.0)))
        limit = min(100, max(1, int(options.get('limit') or 1)))
        batch_id = options.get('batch_id')
        if watch and batch_id:
            raise CommandError('--batch-id is only valid with --once.')

        failures = 0
        processed = 0
        try:
            recovered = recover_stale_quality_imports()
            if recovered:
                self.stdout.write(self.style.WARNING(f'Recovered {recovered} stale processing lease(s).'))
            while not stop.is_set():
                try:
                    result = process_quality_import_batch(
                        batch_id if processed == 0 else None,
                        should_stop=stop.is_set,
                    )
                except Exception as exc:
                    failures += 1
                    self.stderr.write(self.style.ERROR(f'Quality import failed: {exc}'))
                    if not watch:
                        break
                    if stop.wait(poll_seconds):
                        break
                    continue
                if result is None:
                    if watch:
                        if stop.wait(poll_seconds):
                            break
                        continue
                    break
                processed += 1
                self.stdout.write(self.style.SUCCESS(
                    f'Batch {result.id}: {result.status}, rows={result.total_rows}, media={result.total_media}'
                ))
                if not watch and (batch_id or processed >= limit):
                    break
        finally:
            for signum, previous in previous_handlers.items():
                signal.signal(signum, previous)

        if failures and not watch:
            raise CommandError(f'{failures} quality import batch(es) failed.')
        if not processed and not failures:
            self.stdout.write('No queued quality imports.')
