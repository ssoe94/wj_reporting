import time

from django.core.management.base import BaseCommand, CommandError

from injection.models import MouldDataSnapshot
from injection.mould_snapshots import snapshot_is_stale
from injection.mould_views import _refresh_board_snapshot, _refresh_detail_snapshot


class Command(BaseCommand):
    help = 'Refresh persistent BLACKLAKE mould board/detail snapshots.'

    def add_arguments(self, parser):
        parser.add_argument('--details-limit', type=int, default=25)
        parser.add_argument('--all-details', action='store_true')
        parser.add_argument('--board-only', action='store_true')
        parser.add_argument('--force-details', action='store_true')
        parser.add_argument('--instance-id', action='append', default=[])
        parser.add_argument('--retries', type=int, default=3)
        parser.add_argument('--retry-delay', type=float, default=2.0)
        parser.add_argument('--detail-delay', type=float, default=0.3)

    def handle(self, *args, **options):
        self.stdout.write('Refreshing mould board snapshot...')
        try:
            board = _refresh_board_snapshot()
        except Exception as exc:
            raise CommandError(f'Mould board refresh failed: {exc}') from exc
        moulds = board.get('moulds', [])
        self.stdout.write(self.style.SUCCESS(f'Board snapshot saved ({len(moulds)} moulds).'))

        if options['board_only']:
            return

        requested_ids = [str(value).strip() for value in options['instance_id'] if str(value).strip()]
        if requested_ids:
            instance_ids = requested_ids
        else:
            instance_ids = [
                str(row.get('instance_id'))
                for row in moulds
                if isinstance(row, dict) and row.get('instance_id')
            ]

        snapshots = {
            row.instance_id: row
            for row in MouldDataSnapshot.objects.filter(
                kind=MouldDataSnapshot.KIND_DETAIL,
                instance_id__in=instance_ids,
            )
        }
        candidates = [
            instance_id
            for instance_id in instance_ids
            if options['force_details']
            or instance_id not in snapshots
            or snapshot_is_stale(snapshots[instance_id])
        ]
        candidates.sort(
            key=lambda instance_id: (
                1 if instance_id in snapshots else 0,
                snapshots[instance_id].refreshed_at
                if instance_id in snapshots
                else instance_id,
            )
        )
        if not options['all_details']:
            candidates = candidates[:max(0, options['details_limit'])]

        completed = 0
        failed = 0
        for index, instance_id in enumerate(candidates, start=1):
            final_error: Exception | None = None
            attempts = max(1, options['retries'] + 1)
            for attempt in range(1, attempts + 1):
                try:
                    _refresh_detail_snapshot(instance_id)
                    final_error = None
                    break
                except Exception as exc:
                    final_error = exc
                    if attempt < attempts:
                        time.sleep(max(0, options['retry_delay']) * attempt)
            if final_error is None:
                completed += 1
                self.stdout.write(f'[{index}/{len(candidates)}] {instance_id} saved')
            else:
                failed += 1
                self.stderr.write(
                    f'[{index}/{len(candidates)}] {instance_id} failed after '
                    f'{attempts} attempts: {final_error}'
                )
            if index < len(candidates):
                time.sleep(max(0, options['detail_delay']))

        summary = f'Detail snapshots: {completed} saved, {failed} failed.'
        if failed:
            self.stdout.write(self.style.WARNING(summary))
        else:
            self.stdout.write(self.style.SUCCESS(summary))
