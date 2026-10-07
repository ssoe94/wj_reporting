"""Synthetic account-bound MES status reads; no provider or credential issuance."""
from copy import copy
from datetime import date, timedelta
from types import SimpleNamespace
from urllib.parse import urlencode
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate
from rest_framework_simplejwt.tokens import AccessToken

from mes_oauth.app_tokens import ALI, AppCredentialUnavailable
from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM
from mes_oauth.session_guard import InspectionSession
from quality.inspection_blacklake_contract import ROUTE_BASE
from quality.inspection_transport import InspectionUserAccessToken
from .mes_execution_contract import encode_exact_json, parse_json_exact
from .mes_read_status import (
    STATUS_ROUTES, MesProductionStatusReadTransport, StatusReadUnavailable,
    read_mes_production_status,
)
from .mes_read_status_views import MesProductionReadStatusView
from .test_mes_delivery_read_contract import BASE, ack, page, task_row, report, receipt


PATH = '/api/production/mes-read-status/'
SELECTED_DATE = date(2026, 10, 7)
START_MS = 1791331200000  # 2026-10-07 08:00 Asia/Shanghai == 00:00 UTC.
CODE = 'SYNTHETIC-WO'


@override_settings(INSPECTION_PILOT_USER_IDS=[], MES_USER_OAUTH_ENABLED=True,
    MES_INSPECTION_ENABLED=True, MES_USER_OAUTH_PROVIDER_ORIGIN=ALI,
    MES_USER_OAUTH_APP_TOKEN_HEADER='access_token')
class MesReadStatusTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(
            username='SYNTHETIC-status-admin', is_active=True, is_superuser=True)
        self.staff = get_user_model().objects.create_user(
            username='SYNTHETIC-status-staff', is_active=True, is_staff=True)
        self.factory = APIRequestFactory()
        self.session = InspectionSession(self.admin.pk, 'SYNTHETIC-login',
            timezone.now() + timedelta(hours=1), {})
        self.lease = InspectionUserAccessToken('SYNTHETIC-USER-LEASE',
            timezone.now().timestamp() + 600, user_id=BASE + 14)
        self.provider = SimpleNamespace(userinfo=Mock(), exchange=Mock())
        self.configuration = SimpleNamespace(tenant='SYNTHETIC-TENANT')
        self.bodies = self.fixture_bodies()
        self.calls = []
        self.sender = Mock(side_effect=self.send)
        self.provider_factory = self.start(patch('production.mes_read_status.BlacklakeUserOAuthClient',
            return_value=self.provider))
        self.existing_app = self.start(patch('production.mes_read_status.get_existing_app_access_token',
            return_value='SYNTHETIC-EXISTING-APP'))
        self.broker = self.start(patch('production.mes_read_status.call_with_user_credential',
            side_effect=self.use_existing_lease))
        self.start(patch('production.mes_read_status.vault.policy', return_value=self.configuration))
        self.start(patch('production.mes_read_status.vault.expected_user', return_value=BASE + 14))
        self.from_request = self.start(patch.object(InspectionSession, 'from_request',
            return_value=self.session))
        self.start(patch('production.mes_read_status._user_sender', self.sender))
        self.issue = self.start(patch('mes_oauth.app_tokens.AppTokenSupplier._issue',
            side_effect=AssertionError('Status reads must not issue APP credentials.')))
        self.clear = self.start(patch('mes_oauth.vault._clear',
            side_effect=AssertionError('Permission failure must not clear the USER connection.')))
        self.network = self.start(patch('socket.socket.connect',
            side_effect=AssertionError('Only the synthetic sender is permitted.')))
        self.http = self.start(patch('requests.sessions.Session.request',
            side_effect=AssertionError('Status fixtures cannot call HTTP.')))

    def start(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def fixture_bodies(self):
        reported = report()
        reported['reportTime'] = START_MS + 1000
        received = receipt()
        received['operateTime'] = START_MS + 2000
        return {
            'work_order_detail': ack({'id': BASE, 'code': CODE,
                'status': {'code': 99, 'message': 'completed'},
                'access_token': 'SYNTHETIC-RAW-SECRET',
                'checkItems': [{'result': 'SYNTHETIC-PRIVATE-MEASUREMENT'}]}),
            'task_list': page(task_row()),
            'report_records': page(reported),
            'report_receipts': ack([{'progressReportId': BASE + 20, 'inboundRecord': received}]),
        }

    def send(self, url, *, params, data, headers, timeout, allow_redirects):
        matching = [name for name, route in STATUS_ROUTES.items()
            if url == ALI + ROUTE_BASE + route]
        self.assertEqual(len(matching), 1)
        self.assertEqual(params, {'access_token': 'SYNTHETIC-USER-LEASE'})
        self.assertEqual(headers, {'Content-Type': 'application/json'})
        self.assertEqual(timeout, (3, 7))
        self.assertIs(allow_redirects, False)
        action = matching[0]
        self.calls.append((action, parse_json_exact(data)))
        return SimpleNamespace(status_code=200, history=[],
            content=encode_exact_json(self.bodies[action]))

    def use_existing_lease(self, session, **kwargs):
        self.assertIs(session, self.session)
        self.assertEqual(kwargs['operation'], 'read')
        self.assertEqual(kwargs['mes_user_id'], BASE + 14)
        self.assertEqual(kwargs['tenant'], 'SYNTHETIC-TENANT')
        self.assertIs(kwargs['provider'], self.provider)
        self.assertTrue(kwargs['policy_check']())
        return kwargs['callback'](self.lease)

    def request(self, *, user=None, token=None, method='get', query=None, raw_query=None):
        query = {'business_date': SELECTED_DATE.isoformat()} if query is None else query
        target = PATH + ('?' + raw_query if raw_query is not None else '')
        request = getattr(self.factory, method)(target, data={} if raw_query is not None else query)
        if user is not None:
            force_authenticate(request, user=user, token=token)
        return MesProductionReadStatusView.as_view()(request)

    def read(self):
        return read_mes_production_status(self.session, SELECTED_DATE, CODE)

    def assert_no_issuance(self):
        self.issue.assert_not_called()
        self.provider.exchange.assert_not_called()
        self.clear.assert_not_called()
        self.network.assert_not_called()
        self.http.assert_not_called()

    def test_registered_get_without_code_reads_only_fresh_auth_and_changes_no_models(self):
        self.assertEqual(reverse('production-mes-read-status'), PATH)
        client = APIClient()
        client.force_authenticate(user=self.admin)
        with CaptureQueriesContext(connection) as queries:
            response = client.get(PATH, {'business_date': SELECTED_DATE.isoformat()})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['state'], 'not_queried')
        self.assertEqual(response.json()['work_orders'], [])
        self.assertEqual(len(queries), 1)
        self.assertIn('auth_user', queries[0]['sql'])
        self.assertTrue(queries[0]['sql'].lstrip().upper().startswith('SELECT'))
        self.assertIn('no-store', response['Cache-Control'])
        self.assertEqual(response['Referrer-Policy'], 'no-referrer')
        self.from_request.assert_not_called()
        self.broker.assert_not_called()
        self.existing_app.assert_not_called()
        self.sender.assert_not_called()
        self.assert_no_issuance()

    def test_head_with_code_never_starts_mes_or_login_reads(self):
        response = self.request(user=self.admin, method='head',
            query={'business_date': SELECTED_DATE.isoformat(), 'work_order_code': CODE})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['state'], 'not_queried')
        self.from_request.assert_not_called()
        self.broker.assert_not_called()
        self.existing_app.assert_not_called()
        self.sender.assert_not_called()

    def test_anonymous_staff_and_stale_active_or_superuser_snapshot_cannot_read(self):
        self.assertIn(self.request().status_code, (401, 403))
        self.assertEqual(self.request(user=self.staff).status_code, 403)
        for changes in ({'is_active': False}, {'is_superuser': False}):
            with self.subTest(changes=changes):
                get_user_model().objects.filter(pk=self.admin.pk).update(**changes)
                self.assertEqual(self.request(user=self.admin).status_code, 403)
                get_user_model().objects.filter(pk=self.admin.pk).update(is_active=True, is_superuser=True)
        stale = copy(self.admin)
        get_user_model().objects.filter(pk=self.admin.pk).delete()
        self.assertEqual(self.request(user=stale).status_code, 403)
        self.broker.assert_not_called()
        self.existing_app.assert_not_called()

    def test_signed_pilot_claim_presence_sticky_and_current_pilot_configuration_are_denied(self):
        for value in (False, None, True):
            token = AccessToken()
            token[PILOT_SCOPE_CLAIM] = value
            with self.subTest(value=value):
                self.assertEqual(self.request(user=self.admin, token=token).status_code, 403)
        sticky = copy(self.admin)
        sticky._inspection_pilot_scope = True
        self.assertEqual(self.request(user=sticky).status_code, 403)
        for configuration in ([self.admin.pk], 'SYNTHETIC-invalid-json'):
            with self.subTest(configuration=configuration), override_settings(
                    INSPECTION_PILOT_USER_IDS=configuration, INSPECTION_PILOT_ENABLED=False):
                self.assertEqual(self.request(user=self.admin).status_code, 403)
        self.broker.assert_not_called()
        self.existing_app.assert_not_called()

    def test_unknown_duplicate_unsafe_code_or_invalid_date_queries_fail_before_mes(self):
        invalid = [
            [('business_date', '2026-10-07'), ('actor_id', 'SYNTHETIC-other')],
            [('business_date', '2026-10-07'), ('business_date', '2026-10-08')],
            [('business_date', '2026-10-07'), ('work_order_code', CODE), ('work_order_code', CODE)],
        ]
        invalid += [[('business_date', value)] for value in ('', '20261007', '1999-12-31', '2101-01-01', '2026-02-30')]
        invalid += [[('business_date', '2026-10-07'), ('work_order_code', code)]
            for code in (' leading', 'trailing ', 'A\nB', 'A\x7fB', 'X' * 101)]
        for query in invalid:
            with self.subTest(query=query):
                self.assertEqual(self.request(user=self.admin, raw_query=urlencode(query)).status_code, 400)
        self.from_request.assert_not_called()
        self.broker.assert_not_called()
        self.sender.assert_not_called()

    def test_mutation_methods_are_405_with_no_business_or_credential_changes(self):
        for method in ('post', 'put', 'patch', 'delete'):
            with self.subTest(method=method), CaptureQueriesContext(connection) as queries:
                self.assertEqual(self.request(user=self.admin, method=method).status_code, 405)
                self.assertTrue(all(q['sql'].lstrip().upper().startswith('SELECT') for q in queries))
        self.broker.assert_not_called()
        self.sender.assert_not_called()
        self.assert_no_issuance()

    def test_four_exact_reads_use_existing_same_user_supply_and_shanghai_business_window(self):
        with CaptureQueriesContext(connection) as queries:
            response = self.request(user=self.admin,
                query={'business_date': SELECTED_DATE.isoformat(), 'work_order_code': CODE})
        self.assertEqual(response.status_code, 200)
        data = response.data
        self.assertEqual([name for name, _ in self.calls], list(STATUS_ROUTES))
        self.assertEqual(self.calls[0][1], {'workOrderCode': CODE, 'warehouseFlag': False})
        self.assertEqual(self.calls[1][1], {'workOrderIdList': [BASE], 'page': 1, 'size': 25})
        reports = self.calls[2][1]
        self.assertEqual(reports['workOrderIdList'], [BASE])
        self.assertEqual(reports['taskIds'], [BASE + 2])
        self.assertEqual((reports['reportTimeFrom'], reports['reportTimeTo']),
            (START_MS, START_MS + 86400000))
        self.assertEqual(self.calls[3][1], {'ids': [BASE + 20]})
        self.broker.assert_called_once()
        self.existing_app.assert_called_once_with()
        self.provider_factory.assert_called_once_with(origin=ALI,
            app_access_token='SYNTHETIC-EXISTING-APP', app_token_header='access_token')
        self.assertTrue(all(q['sql'].lstrip().upper().startswith('SELECT') for q in queries))
        self.assertEqual(data['state'], 'partial')
        self.assertIs(data['read_only'], True)
        self.assertIs(data['live_writes_enabled'], False)
        order = data['work_orders'][0]
        self.assertEqual(order['id'], str(BASE))
        self.assertEqual(order['production_order']['state'], 'unknown')
        self.assertEqual(order['production']['state'], 'in_progress')
        self.assertEqual(order['inbound']['state'], 'unknown')
        self.assertIn('1', order['inbound']['label'])
        self.assertEqual(order['next_action']['target'], 'MES')
        public = str(data)
        for private in ('SYNTHETIC-USER-LEASE', 'SYNTHETIC-EXISTING-APP',
                'SYNTHETIC-RAW-SECRET', 'SYNTHETIC-PRIVATE-MEASUREMENT', 'SYNTHETIC-PRIVATE-MESSAGE'):
            self.assertNotIn(private, public)
        self.assertEqual(set(order), {'id', 'code', 'production_order', 'production', 'inbound', 'next_action'})
        self.assert_no_issuance()

    def test_permission_denial_stops_after_one_detail_read_and_preserves_user_connection(self):
        self.bodies['work_order_detail'] = {'code': 3500060,
            'subCode': 'URL_NO_PERMISSION', 'message': 'SYNTHETIC-PRIVATE-MESSAGE'}
        data = self.read()
        self.assertEqual(data['state'], 'permission_required')
        self.assertEqual(data['work_orders'], [])
        self.assertEqual([name for name, _ in self.calls], ['work_order_detail'])
        self.assertEqual(self.sender.call_count, 1)
        self.assertTrue(all(item['state'] == 'unverified' for item in data['required_read_permissions']))
        self.assert_no_issuance()

    def test_absent_existing_app_supply_has_no_broker_provider_or_issuance_fallback(self):
        self.existing_app.side_effect = AppCredentialUnavailable('app_credential_existing_supply_unavailable')
        self.assertEqual(self.read()['state'], 'unavailable')
        self.provider_factory.assert_not_called()
        self.broker.assert_not_called()
        self.sender.assert_not_called()
        self.assert_no_issuance()

    def test_only_documented_task_codes_have_meaning_and_receipt_records_never_mean_inbound_complete(self):
        expected = {1: 'waiting', 2: 'in_progress', 3: 'blocked', 4: 'completed', 5: 'cancelled', 99: 'unknown'}
        for code, meaning in expected.items():
            with self.subTest(code=code):
                self.bodies['task_list']['data']['list'][0]['taskStatus'] = {'code': code, 'message': 'completed'}
                data = self.read()
                order = data['work_orders'][0]
                self.assertEqual(order['production']['state'], meaning)
                self.assertEqual(order['production_order']['state'], 'unknown')
                self.assertEqual(order['inbound']['state'], 'unknown')

    def test_incomplete_task_population_cannot_claim_completed_production(self):
        self.bodies['task_list']['data']['list'][0]['taskStatus']['code'] = 4
        self.bodies['task_list']['data']['total'] = 26
        data = self.read()
        self.assertEqual(data['state'], 'partial')
        self.assertNotEqual(data['work_orders'][0]['production']['state'], 'completed')
        self.assertEqual(self.sender.call_count, 4)

    def test_empty_task_population_skips_report_and_receipt_reads(self):
        self.bodies['task_list'] = page()
        data = self.read()
        self.assertEqual([name for name, _ in self.calls], ['work_order_detail', 'task_list'])
        self.assertEqual(data['work_orders'][0]['production']['state'], 'unknown')
        self.assertEqual(data['work_orders'][0]['inbound']['state'], 'unknown')

    def test_foreign_identity_or_outside_business_window_is_unavailable_without_retry(self):
        for stage in STATUS_ROUTES:
            with self.subTest(stage=stage):
                self.bodies = self.fixture_bodies()
                if stage == 'work_order_detail': self.bodies[stage]['data']['code'] = 'SYNTHETIC-OTHER'
                elif stage == 'task_list': self.bodies[stage]['data']['list'][0]['workOrderId'] += 100
                elif stage == 'report_records': self.bodies[stage]['data']['list'][0]['reportTime'] = START_MS + 86400000
                else: self.bodies[stage]['data'][0]['progressReportId'] += 100
                self.calls.clear(); self.sender.reset_mock()
                self.assertEqual(self.read()['state'], 'unavailable')
                self.assertEqual(self.sender.call_count, list(STATUS_ROUTES).index(stage) + 1)

    def test_expired_user_lease_never_reaches_any_mes_route(self):
        self.lease = InspectionUserAccessToken('SYNTHETIC-USER-LEASE',
            timezone.now().timestamp() - 1, user_id=BASE + 14)
        self.assertEqual(self.read()['state'], 'connection_required')
        self.sender.assert_not_called()
        self.assert_no_issuance()

    def test_weak_or_missing_acknowledgement_fails_closed_after_one_read(self):
        for confirmation in ('missing', False, 0.0, 1, None):
            with self.subTest(confirmation=confirmation):
                self.bodies = self.fixture_bodies()
                body = self.bodies['work_order_detail']
                if confirmation == 'missing': del body['needCheck']
                else: body['needCheck'] = confirmation
                self.sender.reset_mock()
                self.assertEqual(self.read()['state'], 'unavailable')
                self.assertEqual(self.sender.call_count, 1)


class MesReadStatusTransportTests(SimpleTestCase):
    def setUp(self):
        self.lease = InspectionUserAccessToken('SYNTHETIC-USER-LEASE', 1600.0, user_id=BASE + 14)
        self.sender = Mock(return_value=SimpleNamespace(status_code=200, history=[],
            content=b'{"code":200,"needCheck":0,"data":{}}'))
        clock = patch('production.mes_read_status.clock.time', return_value=1000.0)
        clock.start(); self.addCleanup(clock.stop)

    def transport(self, **changes):
        values = dict(origin=ALI, credential=self.lease, mes_user_id=BASE + 14, sender=self.sender)
        values.update(changes)
        return MesProductionStatusReadTransport(**values)

    def test_wrong_origin_identity_and_expiry_stop_before_sender(self):
        for changes in ({'origin': 'https://SYNTHETIC.invalid'}, {'mes_user_id': BASE + 16}):
            with self.subTest(changes=changes), self.assertRaises(StatusReadUnavailable):
                self.transport(**changes)
        expired = InspectionUserAccessToken('SYNTHETIC-USER-LEASE', 1000.0, user_id=BASE + 14)
        with self.assertRaises(StatusReadUnavailable) as caught:
            self.transport(credential=expired).post('work_order_detail', {'workOrderCode': CODE})
        self.assertEqual(caught.exception.state, 'connection_required')
        self.sender.assert_not_called()

    def test_only_four_fixed_reads_and_one_call_per_action_are_allowed(self):
        transport = self.transport()
        for action in ('task_start', 'manual_inbound', 'task_detail', '/SYNTHETIC/route'):
            with self.subTest(action=action), self.assertRaises(StatusReadUnavailable):
                transport.post(action, {})
        self.sender.assert_not_called()
        transport.post('work_order_detail', {'workOrderCode': CODE})
        with self.assertRaises(StatusReadUnavailable): transport.post('work_order_detail', {'workOrderCode': CODE})
        self.sender.assert_called_once()
        self.assertEqual(self.sender.call_args.args[0], ALI + ROUTE_BASE + STATUS_ROUTES['work_order_detail'])

    def test_timeout_server_error_or_redirect_is_one_attempt_without_resend(self):
        for failure in ('timeout', 'server', 'redirect'):
            with self.subTest(failure=failure):
                self.sender.reset_mock()
                self.sender.side_effect = TimeoutError('SYNTHETIC-PRIVATE-MESSAGE') if failure == 'timeout' else None
                self.sender.return_value = SimpleNamespace(status_code=500 if failure == 'server' else 200,
                    history=[object()] if failure == 'redirect' else [],
                    content=b'{"code":200,"needCheck":0,"data":{}}')
                transport = self.transport()
                with self.assertRaises(StatusReadUnavailable): transport.post('work_order_detail', {})
                with self.assertRaises(StatusReadUnavailable): transport.post('work_order_detail', {})
                self.sender.assert_called_once()
