from datetime import date, datetime, timedelta
from io import StringIO
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command, CommandError
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from inventory.movement_history import sync_history_day, closed_business_date
from inventory.models import MovementHistoryDay, MovementHistoryRevision, MovementHistoryGroup

URL = '/api/inventory/finished-goods/history/'
REFRESH_URL = URL + 'refresh/'
DAY = date(2026, 10, 18)


def movement(identifier, incoming=True, amount='10.1234', at='2026-10-18T12:30:00+08:00', **extra):
    return {'id': str(identifier), 'warehouse': '成品仓库',
            'createdAt': int(datetime.fromisoformat(at).timestamp() * 1000),
            'material': {'code': 'H55', 'name': '모델 白色', 'specification': 'white'},
            'amount': {'direction': incoming, 'amount': {'amount': amount, 'unit': {'code': 'EA'}}},
            'action': {'code': 1 if incoming else 2, 'message': '入库' if incoming else '出库'},
            'qrCode': 'WJ-7459', 'batchNo': 'LOT-1', 'operator': '张三', **extra}


def identifier_payload_selects(queries):
    return [query['sql'] for query in queries
            if '"inventory_movementhistorygroup"."identifiers"' in query['sql'].split(' FROM ', 1)[0]]


class MovementHistoryTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.client.force_authenticate(get_user_model().objects.create_user(username='reader'))
        self.fetch = patch('inventory.movement_history._fetch_page').start()
        self.now = patch('inventory.movement_history.timezone.now', return_value=datetime.fromisoformat('2026-10-19T10:00:00+08:00')).start()
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
        data = self.query(start_date='2026-10-17', end_date='2026-10-20').data
        self.assertEqual(data['source']['missing_dates'], ['2026-10-17', '2026-10-19'])
        self.assertEqual(data['source']['pending_dates'], ['2026-10-20'])
        self.assertEqual(data['source']['provisional_dates'], [])
        self.assertEqual(data['count'],0)
        self.assertEqual(MovementHistoryDay.objects.count(),1)

    def test_open_collection_observes_0800_business_date_and_capture_cutoff(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T07:59:00+08:00')
        self.fetch.return_value = {'list': [
            movement(1, at='2026-10-22T07:59:59+08:00'),
            movement(2, at='2026-10-22T08:00:00+08:00'),
            movement(3, False, '2', at='2026-10-23T07:58:59+08:00'),
            movement(4, at='2026-10-23T07:59:00+08:00'),
        ], 'total': 4}
        sync_history_day(date(2026, 10, 22), allow_open=True)
        self.assertEqual(self.fetch.call_args.args[1:3], (
            datetime.fromisoformat('2026-10-22T08:00:00+08:00'), self.now.return_value))
        data = self.query(start_date='2026-10-22', end_date='2026-10-23').data
        self.assertEqual(data['totals'][0]['total_in'], '10.1234')
        self.assertEqual(data['totals'][0]['total_out'], '2')
        self.assertEqual(data['source']['provisional_dates'], ['2026-10-22'])
        self.assertEqual(data['source']['pending_dates'], ['2026-10-23'])
        self.assertEqual(data['results'][0]['captured_through'], '2026-10-23T07:59:00+08:00')
        with self.assertRaises(ValueError):
            sync_history_day(date(2026, 10, 22))
        self.fetch.reset_mock()
        with self.assertRaises(ValueError):
            sync_history_day(date(2026, 10, 23), allow_open=True)
        self.fetch.assert_not_called()

        self.now.return_value = datetime.fromisoformat('2026-10-23T08:00:00+08:00')
        self.fetch.return_value = {'list': [], 'total': 0}
        response = self.client.post(REFRESH_URL, {}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['business_date'], '2026-10-23')
        self.assertEqual(self.fetch.call_args.args[1:3], (self.now.return_value, self.now.return_value))
        self.assertEqual(closed_business_date(), date(2026, 10, 22))

    def test_current_ordinary_inbound_is_searchable_by_identifier_without_other_cart_amounts(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T15:30:00+08:00')
        material = {'code': 'ACQ30641403', 'name': 'ACQ30641403 (MCK30023403)', 'specification': 'C/A'}
        self.fetch.return_value = {'list': [
            movement('receipt-20261023-100', amount='100', at='2026-10-23T14:20:00+08:00',
                     material=material, qrCode='TT0940286', trolleyCode='CART-0286', labelCode='LABEL-0286',
                     action={'code': 'ordinary_inbound', 'message': '普通入库'}, storageLocation='成品产出仓位'),
            movement('other-cart-80', amount='80', at='2026-10-23T14:21:00+08:00',
                     material=material, qrCode='TT0940999'),
        ], 'total': 2}
        response = self.client.post(REFRESH_URL, {}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['refreshed'])
        self.assertIn('no-store', response['Cache-Control'].split(', '))
        self.fetch.reset_mock()
        for search in ('tt0940286', 'cart-0286', 'label-0286'):
            data = self.query(start_date='2026-10-23', end_date='2026-10-23', search=search).data
            self.assertEqual(data['count'], 1)
            self.assertEqual(data['totals'][0]['total_in'], '100')
            row = data['results'][0]
            self.assertEqual(row['total_in'], '100')
            self.assertEqual(row['identifier_count'], 1)
            self.assertTrue(row['provisional'])
            self.assertEqual(row['captured_through'], '2026-10-23T15:30:00+08:00')
            details = self.client.get(f"{URL}{row['id']}/", {'search': search}).data['results']
            self.assertEqual([d['qr_code'] for d in details], ['TT0940286'])
            self.assertEqual(details[0]['events'][0]['action_label'], '普通入库')
            self.assertEqual(details[0]['events'][0]['storage_location'], '成品产出仓位')
        model = self.query(start_date='2026-10-23', end_date='2026-10-23', search='acq30641403').data
        self.assertEqual(model['totals'][0]['total_in'], '180')
        self.assertEqual(model['results'][0]['identifier_count'], 2)
        default_range = self.client.get(URL, {'search': 'tt0940286'}).data
        self.assertEqual(default_range['results'][0]['business_date'], '2026-10-23')
        self.assertEqual(default_range['totals'][0]['total_in'], '100')
        self.assertEqual(default_range['source']['provisional_dates'], ['2026-10-23'])
        detail = self.client.get(f"{URL}{model['results'][0]['id']}/", {'search': 'acq30641403'}).data
        self.assertEqual(len(detail['results']), 2)
        self.fetch.assert_not_called()

    def test_get_includes_today_without_upstream_calls_or_persistence(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T15:30:00+08:00')
        self.fetch.side_effect = AssertionError('GET must never collect MES data')
        counts = (MovementHistoryDay.objects.count(), MovementHistoryRevision.objects.count(), MovementHistoryGroup.objects.count())
        data = self.client.get(URL).data
        self.assertEqual(data['source']['missing_dates'], [f'2026-10-{day}' for day in range(17, 24)])
        self.assertEqual(data['source']['pending_dates'], [])
        self.assertEqual(data['source']['provisional_dates'], [])
        self.assertEqual(data['count'], 0)
        self.assertEqual((MovementHistoryDay.objects.count(), MovementHistoryRevision.objects.count(), MovementHistoryGroup.objects.count()), counts)
        self.fetch.assert_not_called()

    def test_refresh_coalesces_recent_capture_then_reloads_after_30_seconds(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T15:30:00+08:00')
        self.fetch.return_value = {'list': [movement(1, at='2026-10-23T14:00:00+08:00')], 'total': 1}
        first = self.client.post(REFRESH_URL, {}, format='json')
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.data['refreshed'])
        self.now.return_value += timedelta(seconds=29)
        cached = self.client.post(REFRESH_URL, {}, format='json')
        self.assertEqual(cached.status_code, 200)
        self.assertFalse(cached.data['refreshed'])
        self.assertEqual(self.fetch.call_count, 1)
        self.now.return_value += timedelta(seconds=1)
        fresh = self.client.post(REFRESH_URL, {}, format='json')
        self.assertEqual(fresh.status_code, 200)
        self.assertTrue(fresh.data['refreshed'])
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(MovementHistoryDay.objects.get().checked_at, self.now.return_value)

    def test_failed_current_refresh_keeps_last_good_capture_and_redacts_failure(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T15:30:00+08:00')
        self.fetch.return_value = {'list': [movement(1, amount='100', at='2026-10-23T14:00:00+08:00')], 'total': 1}
        self.assertEqual(self.client.post(REFRESH_URL, {}, format='json').status_code, 200)
        saved_checked_at = MovementHistoryDay.objects.get().checked_at
        self.now.return_value += timedelta(seconds=31)
        self.fetch.side_effect = RuntimeError('sensitive upstream credentials')
        failure = self.client.post(REFRESH_URL, {}, format='json')
        self.assertEqual(failure.status_code, 503)
        self.assertEqual(failure.data, {'error': 'history_refresh_failed'})
        self.assertEqual(MovementHistoryDay.objects.get().checked_at, saved_checked_at)
        self.assertEqual(MovementHistoryRevision.objects.count(), 1)
        self.fetch.reset_mock()
        data = self.query(start_date='2026-10-23', end_date='2026-10-23').data
        self.assertEqual(data['totals'][0]['total_in'], '100')
        self.assertEqual(data['source']['provisional_dates'], ['2026-10-23'])
        self.assertEqual(data['results'][0]['captured_through'], '2026-10-23T15:30:00+08:00')
        self.fetch.assert_not_called()

    def test_closed_capture_replaces_open_coverage_even_when_movements_are_unchanged(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T15:30:00+08:00')
        self.fetch.return_value = {'list': [movement(1, amount='100', at='2026-10-23T14:00:00+08:00')], 'total': 1}
        self.assertEqual(sync_history_day(date(2026, 10, 23), allow_open=True), 1)
        old = self.query(start_date='2026-10-23', end_date='2026-10-23').data
        old_id = old['results'][0]['id']
        self.now.return_value = datetime.fromisoformat('2026-10-24T08:00:00+08:00')
        still_partial = self.query(start_date='2026-10-23', end_date='2026-10-23').data
        self.assertTrue(still_partial['results'][0]['provisional'])
        self.assertEqual(still_partial['source']['provisional_dates'], ['2026-10-23'])
        self.assertEqual(still_partial['results'][0]['captured_through'], '2026-10-23T15:30:00+08:00')
        self.assertEqual(sync_history_day(date(2026, 10, 23)), 2)
        data = self.query(start_date='2026-10-23', end_date='2026-10-23').data
        self.assertEqual(data['totals'][0]['total_in'], '100')
        self.assertFalse(data['results'][0]['provisional'])
        self.assertEqual(data['source']['provisional_dates'], [])
        self.assertEqual(data['results'][0]['captured_through'], '2026-10-24T08:00:00+08:00')
        self.assertEqual(MovementHistoryRevision.objects.count(), 2)
        self.assertEqual(self.client.get(f'{URL}{old_id}/').data['results'][0]['total_in'], '100')
        self.assertEqual(self.query(start_date='2026-10-23', end_date='2026-10-23', snapshot_token=old['snapshot_token']).status_code, 409)

    def test_identifier_direction_filter_uses_matching_events_including_zero_quantity(self):
        self.collect([
            movement(1, amount='0', qrCode='ZERO-IN'),
            movement(2, False, '5', qrCode='OTHER-OUT'),
        ])
        data = self.query(search='zero-in', direction='in').data
        self.assertEqual(data['count'], 1)
        self.assertEqual(data['totals'][0]['total_in'], '0')
        details = self.client.get(f"{URL}{data['results'][0]['id']}/", {'search': 'zero-in', 'direction': 'in'}).data
        self.assertEqual(details['results'][0]['events'][0]['quantity'], '0')
        outgoing = self.query(search='zero-in', direction='out').data
        self.assertEqual(outgoing['count'], 0)
        self.assertEqual(outgoing['totals'], [])

    def test_model_search_uses_stored_aggregates_without_loading_identifier_payload(self):
        self.collect([movement(1, amount='100')])
        # Many movements may share a barcode. Model totals already exist, so
        # their event population must not force identifier JSON projection.
        MovementHistoryGroup.objects.update(inbound_count=20001)
        self.fetch.reset_mock()
        for search in ('h55', '白色', 'white'):
            with CaptureQueriesContext(connection) as queries:
                response = self.query(search=search)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data['count'], 1)
            self.assertEqual(response.data['totals'][0]['total_in'], '100')
            self.assertEqual(response.data['results'][0]['identifier_count'], 1)
            self.assertEqual(identifier_payload_selects(queries), [])
        self.fetch.assert_not_called()

    def test_identifier_search_rejects_over_budget_before_selecting_event_payload(self):
        self.collect([movement(1, amount='100', qrCode='TT0940286')])
        MovementHistoryGroup.objects.update(inbound_count=20001)
        self.fetch.reset_mock()
        with CaptureQueriesContext(connection) as queries:
            response = self.query(search='tt0940286')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {'error': 'history_range_too_large'})
        self.assertEqual(identifier_payload_selects(queries), [])
        self.fetch.assert_not_called()

    def test_identifier_search_at_event_budget_projects_only_matching_barcode(self):
        self.collect([
            movement(1, amount='100', qrCode='TT0940286'),
            movement(2, amount='80', qrCode='TT0940999'),
        ])
        MovementHistoryGroup.objects.update(inbound_count=20000)
        self.fetch.reset_mock()
        with CaptureQueriesContext(connection) as queries:
            response = self.query(search='tt0940286')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['count'], 1)
        self.assertEqual(response.data['totals'][0]['total_in'], '100')
        self.assertEqual(response.data['results'][0]['identifier_count'], 1)
        self.assertEqual(len(identifier_payload_selects(queries)), 1)
        self.fetch.assert_not_called()

    def test_refresh_auth_methods_and_parameter_validation(self):
        self.assertEqual(self.client.get(REFRESH_URL).status_code, 405)
        for payload in ({'business_date': '2026-10-24'}, {'allow_open': True}, {'unknown': 'value'}):
            self.assertEqual(self.client.post(REFRESH_URL, payload, format='json').status_code, 400)
        self.assertEqual(self.client.post(REFRESH_URL + '?business_date=2026-10-24', {}, format='json').status_code, 400)
        self.assertEqual(MovementHistoryDay.objects.count(), 0)
        self.fetch.assert_not_called()
        anonymous = APIClient()
        self.assertEqual(anonymous.post(REFRESH_URL, {}, format='json').status_code, 401)
        self.fetch.assert_not_called()

    def test_refresh_is_throttled_per_authenticated_user(self):
        self.now.return_value = datetime.fromisoformat('2026-10-23T15:30:00+08:00')
        responses = [self.client.post(REFRESH_URL, {}, format='json') for _ in range(7)]
        self.assertEqual([response.status_code for response in responses], [200] * 6 + [429])
        self.assertEqual(self.fetch.call_count, 1)
        self.assertIn('Retry-After', responses[-1])

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
