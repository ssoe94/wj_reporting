from datetime import date, datetime, timedelta
from io import StringIO
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.core.management import call_command, CommandError
from django.test import TestCase
from rest_framework.test import APIClient
from inventory.movement_history import sync_history_day, closed_business_date
from inventory.models import MovementHistoryDay, MovementHistoryRevision, MovementHistoryGroup

URL = '/api/inventory/finished-goods/history/'
DAY = date(2026, 10, 18)


def movement(identifier, incoming=True, amount='10.1234', at='2026-10-18T12:30:00+08:00', **extra):
    return {'id': str(identifier), 'warehouse': '成品仓库',
            'createdAt': int(datetime.fromisoformat(at).timestamp() * 1000),
            'material': {'code': 'H55', 'name': '모델 白色', 'specification': 'white'},
            'amount': {'direction': incoming, 'amount': {'amount': amount, 'unit': {'code': 'EA'}}},
            'action': {'code': 1 if incoming else 2, 'message': '入库' if incoming else '出库'},
            'qrCode': 'WJ-7459', 'batchNo': 'LOT-1', 'operator': '张三', **extra}


class MovementHistoryTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.force_authenticate(get_user_model().objects.create_user(username='reader'))
        self.fetch = patch('inventory.movement_history._fetch_page').start()
        patch('inventory.movement_history.timezone.now', return_value=datetime.fromisoformat('2026-10-19T10:00:00+08:00')).start()
        self.addCleanup(patch.stopall)
        self.fetch.return_value = {'list': [], 'total': 0}

    def collect(self, rows, day=DAY):
        self.fetch.return_value = {'list': rows, 'total': len(rows)}
        return sync_history_day(day)

    def query(self, **params):
        return self.client.get(URL, {'start_date': '2026-10-18', 'end_date': '2026-10-18', **params})

    def test_daily_summary_and_same_number_both_directions_exact_decimals(self):
        self.collect([movement(1, amount='1234567890123456.1234'), movement(2, False, '2.1000')])
        self.fetch.reset_mock()
        data = self.query().data
        self.assertEqual(data['count'], 1)
        self.assertEqual(data['totals'], [{'unit': 'EA', 'total_in': '1234567890123456.1234', 'total_out': '2.1000', 'net_change': '1234567890123454.0234'}])
        row = data['results'][0]
        self.assertEqual(row['identifier_count'], 1)
        self.assertNotIn('identifiers', row)
        details = self.client.get(f"{URL}{row['id']}/").data['results']
        self.assertEqual(len(details), 1)
        self.assertEqual(details[0]['qr_code'], 'WJ-7459')
        self.assertEqual(details[0]['trolley_code'], '')
        self.assertEqual([e['direction'] for e in details[0]['events']], ['in', 'out'])
        self.assertEqual(details[0]['total_out'], '2.1000')
        self.fetch.assert_not_called()

    def test_boundaries_and_warehouse_scope(self):
        self.collect([movement(1, at='2026-10-18T07:59:59+08:00'), movement(2, at='2026-10-18T08:00:00+08:00'),
            movement(3, False, '2', at='2026-10-19T07:59:59+08:00'), movement(4, at='2026-10-19T08:00:00+08:00'), movement(5, warehouse='原材料仓库')])
        self.assertEqual(self.query().data['totals'][0]['total_in'], '10.1234')
        self.assertEqual(self.query().data['totals'][0]['total_out'], '2')
        self.assertEqual(closed_business_date(datetime.fromisoformat('2026-10-19T07:59:59+08:00')), date(2026,10,17))
        with self.assertRaises(ValueError): sync_history_day(date(2026,10,19))

    def test_missing_identifiers_units_and_separate_cart_fields(self):
        kg = {'direction': True, 'amount': {'amount': '3', 'unit': {'code':'kg'}}}
        self.collect([movement(1, qrCode=''), movement(2, qrCode='TT0940411'), {**movement(3), 'amount': kg}, movement(4, qrCode='物流1', trolleyCode='CART1', labelCode='LABEL1')])
        data = self.query().data
        self.assertEqual(data['count'], 2)
        ea = next(row for row in data['results'] if row['unit'] == 'EA')
        self.assertEqual(ea['missing_identifier_count'], 1)
        self.assertEqual(ea['identifier_count'], 2)
        details = self.client.get(f"{URL}{ea['id']}/").data['results']
        self.assertTrue(any(d['qr_code'] == '' for d in details))
        self.assertTrue(any(d['trolley_code'] == 'CART1' and d['label_code'] == 'LABEL1' for d in details))

    def test_idempotent_collection_corrections_retain_old_revision_and_details(self):
        self.assertEqual(self.collect([movement(1)]), 1)
        old = self.query().data
        old_id = old['results'][0]['id']
        self.assertEqual(self.collect([movement(1)]), 1)
        self.assertEqual(MovementHistoryRevision.objects.count(), 1)
        self.assertEqual(self.collect([movement(1, amount='20')]), 2)
        self.assertEqual(MovementHistoryRevision.objects.count(), 2)
        self.assertEqual(self.query().data['totals'][0]['total_in'], '20')
        self.assertEqual(self.client.get(f'{URL}{old_id}/').data['results'][0]['total_in'], '10.1234')
        self.assertEqual(self.query(page=2, snapshot_token=old['snapshot_token']).status_code, 409)

    def test_failure_preserves_published_data(self):
        self.collect([movement(1)])
        self.fetch.side_effect = RuntimeError('sensitive upstream error')
        with self.assertRaises(RuntimeError): sync_history_day(DAY)
        self.assertEqual(self.query().data['totals'][0]['total_in'], '10.1234')
        self.assertEqual(MovementHistoryRevision.objects.count(), 1)

    def test_incomplete_and_invalid_source_never_published(self):
        for rows, total in [([movement(1)], 2), ([movement(1), movement(1)],2), ([movement('')],1),
            ([movement(2, incoming='unknown')],1), ([movement(3, amount='NaN')],1),
            ([movement(4, createdAt='bad')],1), ([None],1)]:
            self.fetch.return_value = {'list': rows, 'total':total}
            with self.assertRaises((RuntimeError, ValueError)): sync_history_day(DAY)
        self.assertEqual(MovementHistoryDay.objects.count(), 0)

    @patch('inventory.movement_history.PAGE_SIZE', 2)
    def test_full_pagination_before_publication(self):
        self.fetch.side_effect = [{'list':[movement(3), movement(2)], 'total':3}, {'list':[movement(1)], 'total':3}]
        sync_history_day(DAY)
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(self.query().data['totals'][0]['total_in'], '30.3702')

    @patch('inventory.movement_history.PAGE_SIZE', 2)
    def test_moving_total_is_rejected(self):
        self.fetch.side_effect = [{'list':[movement(3), movement(2)], 'total':3}, {'list':[movement(1)], 'total':4}]
        with self.assertRaises(RuntimeError): sync_history_day(DAY)
        self.assertEqual(MovementHistoryDay.objects.count(), 0)

    def test_query_filters_and_pagination(self):
        self.collect([movement(1), movement(2, False,'3'), movement(3, material={'code':'OTHER'})])
        first = self.query(page_size=1).data
        second = self.query(page=2, page_size=1, snapshot_token=first['snapshot_token']).data
        self.assertEqual(second['results'][0]['material_code'], 'OTHER')
        data = self.query(search='白色', direction='out').data
        self.assertEqual(data['count'], 1)
        self.assertEqual(data['totals'][0]['total_in'], '0')
        self.assertEqual(data['totals'][0]['total_out'], '3')
        detail = self.client.get(f"{URL}{data['results'][0]['id']}/", {'direction':'out'}).data['results'][0]
        self.assertEqual(len(detail['events']),1)
        self.assertEqual(detail['total_in'],'0')
        self.assertEqual(self.query(page=2).status_code,400)

    def test_missing_zero_and_pending_dates_are_distinct_without_query_writes(self):
        self.collect([])
        data = self.query(start_date='2026-10-17', end_date='2026-10-19').data
        self.assertEqual(data['source']['missing_dates'], ['2026-10-17'])
        self.assertEqual(data['source']['pending_dates'], ['2026-10-19'])
        self.assertEqual(data['count'],0)
        self.assertEqual(MovementHistoryDay.objects.count(),1)

    def test_read_auth_validation_and_methods(self):
        for params in [{'start_date':'2026-10-20'}, {'start_date':'2025-01-01'}, {'page_size':201}, {'direction':'bad'}, {'ordering':'bad'}, {'search':'a'*101}]:
            self.assertEqual(self.query(**params).status_code,400)
        self.assertEqual(self.client.post(URL,{}).status_code,405)
        self.assertEqual(self.client.get(f'{URL}999/').status_code,404)
        self.client = APIClient()
        self.assertEqual(self.query().status_code,401)
        self.assertEqual(self.client.get(f'{URL}999/').status_code,401)
        self.fetch.assert_not_called()

    def test_older_capture_cannot_replace_newer(self):
        self.collect([movement(1)])
        MovementHistoryDay.objects.update(checked_at=datetime.fromisoformat('2026-10-19T11:00:00+08:00'))
        self.collect([movement(1, amount='99')])
        self.assertEqual(self.query().data['totals'][0]['total_in'],'10.1234')

    @patch('inventory.management.commands.sync_movement_history.sync_history_day')
    def test_command_continues_other_days_and_reports_failure_without_source_secrets(self, sync):
        sync.side_effect = [RuntimeError('secret'), 1]
        err = StringIO()
        with self.assertRaises(CommandError):
            call_command('sync_movement_history', start_date='2026-10-17',end_date='2026-10-18', stdout=StringIO(),stderr=err)
        self.assertEqual(sync.call_count,2)
        self.assertNotIn('secret',err.getvalue())

    def test_history_is_not_in_old_snapshot_cleanup(self):
        # Independence is structural: no FK from history to ephemeral snapshots.
        self.collect([movement(1)])
        from inventory.models import DailyInventorySnapshot, DailyReportSummary
        DailyInventorySnapshot.objects.all().delete()
        DailyReportSummary.objects.all().delete()
        self.assertEqual(MovementHistoryGroup.objects.count(),1)

    @patch('inventory.movement_history.MovementHistoryGroup.objects.bulk_create')
    def test_publication_error_rolls_back_entire_new_revision(self, save):
        save.side_effect = RuntimeError('database failure')
        with self.assertRaises(RuntimeError): self.collect([movement(1)])
        self.assertEqual(MovementHistoryDay.objects.count(), 0)
        self.assertEqual(MovementHistoryRevision.objects.count(), 0)

    def test_daily_hook_preserves_existing_snapshot_work_on_history_failure(self):
        from inventory import tasks
        with patch.object(tasks, 'call_command') as command, patch.object(tasks, 'create_daily_summary'), patch.object(tasks, 'cleanup_old_snapshots'), patch.object(tasks, 'run_raw_material_sync', return_value=(True, {'status':'completed'})) as raw:
            command.side_effect = [RuntimeError('unavailable'), None]
            with self.assertRaisesRegex(RuntimeError, 'history requires retry'):
                tasks.daily_inventory_automation()
            self.assertEqual([c.args[0] for c in command.call_args_list], ['sync_movement_history', 'create_daily_snapshot'])
            raw.assert_called_once()

    def test_render_daily_command_collects_history_even_if_inventory_fails(self):
        from inventory.management.commands.daily_snapshot_auto import Command
        with patch.object(Command, '_handle_snapshot', side_effect=CommandError('snapshot failed')), patch('inventory.management.commands.daily_snapshot_auto.call_command') as collect:
            with self.assertRaisesRegex(CommandError, 'snapshot failed'):
                Command().handle(date=None, skip_fetch=False)
            self.assertEqual(collect.call_args.args[0], 'sync_movement_history')
        with patch.object(Command, '_handle_snapshot'), patch('inventory.management.commands.daily_snapshot_auto.call_command') as collect:
            Command().handle(date=None, skip_fetch=True)
            collect.assert_not_called()
