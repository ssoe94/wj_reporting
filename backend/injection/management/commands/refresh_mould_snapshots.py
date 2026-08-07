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
                snapshots[instance_id].refreshed_at
                if instance_id in snapshots
                else snapshots[next(iter(snapshots))].refreshed_at.replace(year=2000)
                if snapshots
                else board.get('final_changed_at', '')
            )
        )
        if not options['all_details']:
            candidates = candidates[:max(0, options['details_limit'])]

        completed = 0
        failed = 0
        for index, instance_id in enumerate(candidates, start=1):
            try:
                _refresh_detail_snapshot(instance_id)
                completed += 1
                self.stdout.write(f'[{index}/{len(candidates)}] {instance_id} saved')
            except Exception as exc:
                failed += 1
                self.stderr.write(f'[{index}/{len(candidates)}] {instance_id} failed: {exc}')

        summary = f'Detail snapshots: {completed} saved, {failed} failed.'
        if failed:
            self.stdout.write(self.style.WARNING(summary))
        else:
            self.stdout.write(self.style.SUCCESS(summary))
