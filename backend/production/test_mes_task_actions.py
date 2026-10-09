"""MES task action checks, run by scripts/check-mes-task-reconciliation.py. No network."""
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from rest_framework.test import APIRequestFactory, force_authenticate

from .mes_task_actions import (
    CLOSE_PATH, DETAIL_PATH, ActionRequestError, execute_actions, mes_sender, parse_items,
)
from .mes_task_actions_views import MesTaskActionView
from .mes_task_reconciliation_service import TASK_LIST_CACHE_KEY
from .models import MesTaskActionLog


def item(action='pause', task_id='101', status=2, machine=17, code='GD-1-RW-00001', work_order='GD-1', part='P-1'):
    return {
        'action': action, 'task_id': task_id, 'task_code': code, 'machine_number': machine,
        'expected_status': status, 'work_order_code': work_order, 'part_no': part,
    }


def detail(task_id='101', status=2, machine=17, code='GD-1-RW-00001', work_order='GD-1'):
    return {'code': 200, 'data': {
        'taskId': int(task_id), 'taskCode': code, 'taskStatus': {'code': status},
        'equipments': [{'id': 1, 'name': f'{machine}号注塑机', 'code': 'X'}],
        'relatedWorkOrderCode': work_order,
    }}


class FakeMes:
    """Scripted MES: a queue of detail responses and write responses; records every call."""

    def __init__(self, details, writes=None):
        self.details = list(details)
        self.writes = list(writes or [])
        self.calls = []

    def __call__(self, path, body):
        self.calls.append((path, body))
        if path == DETAIL_PATH:
            response = self.details.pop(0)
        else:
            response = self.writes.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def write_paths(self):
        return [path for path, _ in self.calls if path != DETAIL_PATH]


class RouteTransportTests(SimpleTestCase):
    def test_route_query_authentication_is_used_once(self):
        response = Mock()
        response.json.return_value = {'code': 200, 'data': {}}
        with patch('requests.post', return_value=response) as post, \
                patch('inventory.mes.get_access_token', return_value='synthetic-token'):
            self.assertEqual(mes_sender(DETAIL_PATH, {'taskId': 101}), response.json.return_value)
        post.assert_called_once()
        args, kwargs = post.call_args
        self.assertTrue(args[0].endswith(DETAIL_PATH))
        self.assertNotIn('synthetic-token', args[0])
        self.assertEqual(kwargs['params'], {'access_token': 'synthetic-token'})
        self.assertEqual(kwargs['json'], {'taskId': 101})

    def test_detail_permission_denied_never_submits_an_action(self):
        mes = FakeMes([{'code': 3500060, 'subCode': 'OPENAPI-DOMAIN/URL_NO_PERMISSION'}])
        items, reason = parse_items({'reason': '상태 확인', 'items': [item()]})
        results = execute_actions(items, reason, send=mes, actor_label='test')
        self.assertEqual(results[0]['outcome'], 'blocked')
        self.assertEqual(results[0]['reason'], 'mes_read_failed')
        self.assertEqual(mes.write_paths(), [])


class ParseTests(SimpleTestCase):
    def test_valid_request(self):
        items, reason = parse_items({'reason': ' 금형 교체 ', 'items': [item(), item('start', '102', 1)]})
        self.assertEqual(reason, '금형 교체')
        self.assertEqual([entry.action for entry in items], ['pause', 'start'])

    def test_rejects_bad_requests_before_any_mes_call(self):
        bad = [
            None, {'items': [item()]}, {'reason': ' ', 'items': [item()]}, {'reason': 'x' * 201, 'items': [item()]},
            {'reason': 'r', 'items': []}, {'reason': 'r', 'items': [item()] * 31},
            {'reason': 'r', 'items': [item(action='finish')]},
            {'reason': 'r', 'items': [item(task_id='12a')]},
            {'reason': 'r', 'items': [item(machine=18)]},
            {'reason': 'r', 'items': [item(status=4)]},
            {'reason': 'r', 'items': [item('start', status=2)]},  # start needs 待执行
            {'reason': 'r', 'items': [item('resume', status=2)]},  # resume needs 暂停中
            {'reason': 'r', 'items': [item('close_work_order', work_order='')]},
            {'reason': 'r', 'items': [item(), item()]},
        ]
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(ActionRequestError):
                parse_items(payload)


class ExecuteTests(SimpleTestCase):
    def run_items(self, mes, *entries, reason='계획 외 작업'):
        items, reason = parse_items({'reason': reason, 'items': list(entries)})
        return execute_actions(items, reason, send=mes, actor_label='kim#7', operator_id=99, clock=lambda: 1_700_000_000)

    def test_pause_is_sent_once_and_confirmed_by_readback(self):
        mes = FakeMes([detail(status=2), detail(status=3)], [{'code': 200, 'data': {}}])
        [result] = self.run_items(mes, item())
        self.assertEqual(result['outcome'], 'confirmed')
        self.assertEqual(result['status_after'], 3)
        self.assertEqual(mes.write_paths(), ['/mfg/open/v2/produce_task/_pause'])
        body = mes.calls[1][1]
        self.assertEqual(body, {
            'taskId': 101, 'operateTime': 1_700_000_000_000, 'operatorId': 99,
            'operateReason': '계획 외 작업', 'remark': 'WJ:kim#7',
        })

    def test_start_and_resume_use_their_own_endpoints(self):
        mes = FakeMes(
            [detail('1', 1), detail('1', 2), detail('2', 3), detail('2', 2)],
            [{'code': 200}, {'code': 200}],
        )
        results = self.run_items(mes, item('start', '1', 1), item('resume', '2', 3))
        self.assertEqual([r['outcome'] for r in results], ['confirmed', 'confirmed'])
        self.assertEqual(mes.write_paths(), ['/mfg/open/v2/produce_task/_start', '/mfg/open/v2/produce_task/_resume'])
        self.assertEqual(mes.calls[1][1], {'taskId': 1})

    def test_changed_mes_state_blocks_without_writing(self):
        cases = [
            (detail(status=3), 'status_changed'),
            (detail(machine=16), 'machine_changed'),
            (detail(code='OTHER'), 'task_identity_changed'),
            (detail(work_order='GD-9'), 'work_order_changed'),
            ({'code': 500}, 'mes_read_failed'),
            (RuntimeError('timeout'), 'mes_read_failed'),
        ]
        for response, reason in cases:
            with self.subTest(reason=reason):
                mes = FakeMes([response])
                [result] = self.run_items(mes, item())
                self.assertEqual((result['outcome'], result['reason']), ('blocked', reason))
                self.assertEqual(mes.write_paths(), [])

    def test_rejection_keeps_mes_message_without_secrets(self):
        mes = FakeMes([detail()], [{'code': 400, 'subCode': 'E1', 'needCheck': 1,
                                    'message': 'access_token=abc 任务状态不允许暂停'}])
        [result] = self.run_items(mes, item())
        self.assertEqual(result['outcome'], 'rejected')
        self.assertEqual(result['need_check'], 1)
        self.assertNotIn('abc', result['mes_message'])
        self.assertIn('任务状态不允许暂停', result['mes_message'])

    def test_unknown_write_outcome_is_uncertain_and_never_retried(self):
        mes = FakeMes([detail()], [RuntimeError('connection reset')])
        [result] = self.run_items(mes, item())
        self.assertEqual((result['outcome'], result['reason']), ('uncertain', 'write_outcome_unknown'))
        self.assertEqual(len(mes.write_paths()), 1)

    def test_success_response_without_matching_readback_is_uncertain(self):
        mes = FakeMes([detail(status=2), detail(status=2)], [{'code': 200}])
        [result] = self.run_items(mes, item())
        self.assertEqual((result['outcome'], result['reason']), ('uncertain', 'readback_mismatch'))

    def test_matching_status_on_another_task_machine_or_order_is_not_confirmation(self):
        for after in [detail(task_id='999'), detail(code='OTHER'), detail(machine=16), detail(work_order='OTHER')]:
            after['data']['taskStatus']['code'] = 3
            with self.subTest(after=after):
                mes = FakeMes([detail(status=2), after], [{'code': 200}])
                [result] = self.run_items(mes, item())
                self.assertEqual((result['outcome'], result['reason']), ('uncertain', 'readback_mismatch'))
                self.assertEqual(len(mes.write_paths()), 1)

    def test_close_acknowledgment_without_readback_is_never_confirmation(self):
        for data in [
            {'successAmount': 0, 'failAmount': 1, 'failResults': []},
            {'successAmount': 99, 'failAmount': 0, 'failResults': []},
            {'successAmount': 1, 'failAmount': 0, 'failResults': []},
            {},
        ]:
            with self.subTest(data=data):
                mes = FakeMes([detail()], [{'code': 200, 'data': data}])
                [result] = self.run_items(mes, item('close_work_order'))
                self.assertEqual((result['outcome'], result['reason']), ('uncertain', 'close_readback_unverified'))
                self.assertEqual(mes.write_paths(), [CLOSE_PATH])

    def test_work_orders_close_in_one_call_with_per_order_results(self):
        mes = FakeMes(
            [detail('1', 2, work_order='GD-1'), detail('2', 3, work_order='GD-2', code='C2'), detail('3', 1, work_order='GD-1', code='C3')],
            [{'code': 200, 'data': {'successAmount': 1, 'failAmount': 1,
                                    'failResults': [{'workOrderCode': 'GD-2', 'failedReason': '工单状态不允许关闭'}]}}],
        )
        results = self.run_items(
            mes,
            item('close_work_order', '1', 2, work_order='GD-1'),
            item('close_work_order', '2', 3, work_order='GD-2', code='C2'),
            item('close_work_order', '3', 1, work_order='GD-1', code='C3'),
        )
        self.assertEqual([r['outcome'] for r in results], ['uncertain', 'rejected', 'uncertain'])
        self.assertEqual(mes.write_paths(), [CLOSE_PATH])
        self.assertEqual(mes.calls[-1][1], {'workOrderCodeList': ['GD-1', 'GD-2'], 'operateReason': '계획 외 작업'})
        self.assertIn('不允许', results[1]['mes_message'])


class ActionViewTests(TestCase):
    def setUp(self):
        cache.set(TASK_LIST_CACHE_KEY, {'tasks': []})
        self.factory = APIRequestFactory()
        self.staff = get_user_model().objects.create_user('lead', password='x', is_staff=True)
        self.viewer = get_user_model().objects.create_user('viewer', password='x')

    def post(self, user, payload):
        request = self.factory.post('/api/production/mes-task-actions/', payload, format='json')
        force_authenticate(request, user=user)
        return MesTaskActionView.as_view()(request)

    def test_disabled_by_default_and_reported_by_get(self):
        response = self.post(self.staff, {'reason': 'r', 'items': [item()]})
        self.assertEqual(response.status_code, 409)
        request = self.factory.get('/api/production/mes-task-actions/')
        force_authenticate(request, user=self.staff)
        self.assertEqual(MesTaskActionView.as_view()(request).data, {'enabled': False, 'permitted': True})
        self.assertFalse(MesTaskActionLog.objects.exists())

    @override_settings(MES_TASK_ACTIONS_ENABLED=True)
    def test_requires_plan_edit_permission(self):
        self.assertEqual(self.post(self.viewer, {'reason': 'r', 'items': [item()]}).status_code, 403)

    @override_settings(MES_TASK_ACTIONS_ENABLED=True)
    def test_invalid_request_writes_nothing(self):
        response = self.post(self.staff, {'reason': '', 'items': [item()]})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(MesTaskActionLog.objects.exists())

    @override_settings(MES_TASK_ACTIONS_ENABLED=True, MES_TASK_ACTION_OPERATOR_ID=None)
    def test_logs_every_result_with_the_server_actor_and_clears_task_cache(self):
        mes = FakeMes([detail(status=2), detail(status=3), detail('5', 3)], [{'code': 200}])
        original = MesTaskActionView.sender
        MesTaskActionView.sender = staticmethod(mes)
        try:
            response = self.post(self.staff, {
                'reason': '계획 외', 'actor': 'spoofed',
                'items': [item(), item('resume', '5', 2)],
            })
        finally:
            MesTaskActionView.sender = original
        self.assertEqual(response.status_code, 400)  # resume from 执行中 is rejected up front
        mes = FakeMes([detail(status=2), detail(status=3)], [{'code': 200}])
        MesTaskActionView.sender = staticmethod(mes)
        try:
            response = self.post(self.staff, {'reason': '계획 외', 'actor': 'spoofed', 'items': [item()]})
        finally:
            MesTaskActionView.sender = original
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['results'][0]['outcome'], 'confirmed')
        log = MesTaskActionLog.objects.get()
        self.assertEqual((log.actor, log.action, log.outcome, log.status_after), (self.staff, 'pause', 'confirmed', 3))
        self.assertEqual(log.request_id, response.data['request_id'])
        self.assertIsNone(cache.get(TASK_LIST_CACHE_KEY))
