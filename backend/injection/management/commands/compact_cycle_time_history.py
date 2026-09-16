"""Compress existing hourly C/T objects without deleting evidence or revisions."""
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db import connection, reset_queries, transaction
from django.utils import timezone

from injection.cycle_time_codec import pack, serialized, unpack
from injection.cycle_time_history import ARCHIVE_LOCK_KEY
from injection.models import InjectionCycleTimeBucket, InjectionCycleTimeRevision, InjectionMonitoringRecord


class Command(BaseCommand):
    help = 'Losslessly compact hourly C/T JSON. Dry-run by default; deploy compatible readers before --apply.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--batch-size', type=int, default=100)
        parser.add_argument('--limit', type=int, default=0, help='Optional per-table row limit.')
        parser.add_argument('--max-db-mb', type=int, default=1800)
        parser.add_argument('--require-fresh-machines', type=int, default=0)

    def handle(self, *args, **options):
        if not 1 <= options['batch_size'] <= 1000 or options['limit'] < 0 or options['max_db_mb'] <= 0:
            raise CommandError('Invalid compaction bounds')
        for model, fields in ((InjectionCycleTimeBucket, ['payload', 'summary']), (InjectionCycleTimeRevision, ['payload'])):
            last_id = seen = changed = before = after = 0
            # Bound this run even while live collectors add newer rows.
            final_id = model.objects.order_by('-pk').values_list('pk', flat=True).first() or 0
            while last_id < final_id:
                remaining = options['limit'] - seen if options['limit'] else options['batch_size']
                if remaining <= 0:
                    break
                with transaction.atomic():
                    if options['apply'] and connection.vendor == 'postgresql':
                        with connection.cursor() as cursor:
                            cursor.execute('SELECT pg_database_size(current_database())')
                            if cursor.fetchone()[0] > options['max_db_mb'] * 1024 * 1024:
                                raise CommandError('Paused: database size guard')
                            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [ARCHIVE_LOCK_KEY])
                    if options['apply'] and options['require_fresh_machines']:
                        fresh = InjectionMonitoringRecord.objects.filter(
                            timestamp__gte=timezone.now() - timedelta(minutes=5),
                        ).values('device_code').distinct().count()
                        if fresh < options['require_fresh_machines']:
                            raise CommandError('Paused: live collection freshness guard')
                    query = model.objects.filter(pk__gt=last_id, pk__lte=final_id).order_by('pk').only('pk', *fields)
                    if options['apply']:
                        query = query.select_for_update()
                    rows = list(query[:min(options['batch_size'], remaining)])
                    if not rows:
                        break
                    updates = []
                    for row in rows:
                        modified = False
                        for field in fields:
                            original = getattr(row, field)
                            encoded = pack(original)
                            if unpack(encoded) != unpack(original):
                                raise CommandError('Compression verification failed')
                            before += len(serialized(original))
                            after += len(serialized(encoded))
                            modified |= encoded != original
                            setattr(row, field, encoded)
                        if modified:
                            updates.append(row)
                    if options['apply'] and updates:
                        # No auto timestamps, calculation hashes or semantic revisions change.
                        model.objects.bulk_update(updates, fields, batch_size=options['batch_size'])
                    seen += len(rows)
                    changed += len(updates)
                    last_id = rows[-1].pk
                # A DEBUG-enabled maintenance process must not retain every bulk SQL statement.
                reset_queries()
                if seen % 10000 == 0:
                    self.stdout.write(f'{model.__name__}: scanned={seen} changed={changed}')
                    self.stdout.flush()
            self.stdout.write(str({'model': model.__name__, 'applied': options['apply'], 'scanned': seen,
                                   'changed': changed, 'serialized_bytes_before': before, 'serialized_bytes_after': after}))
            self.stdout.flush()
