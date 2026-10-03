"""Document contract fixtures only: no real token, network, tenant or QC writes."""
from decimal import Decimal
from types import SimpleNamespace
import sys
from unittest.mock import Mock, patch

from unittest import TestCase

from .inspection_adapter import get_inspection_adapter, MesContractUnavailable, MesOutcomeUnknown, MesRejected
from .inspection_blacklake_contract import (
    DocumentedStage, ITEM_RECORD, ROUTE_BASE, TASK_DETAIL, TASK_FINISH, TASK_LIST,
    ScopedInspectionReadClient, encode_payload, result_and_finish_plan,
)
from .inspection_transport import BlacklakeInspectionTransport, MesAccessDenied, ReviewedWriteAuthorization, existing_runtime_token, stages_digest


WORK_ORDER = 10000000000000001
QC_TASK = 10000000000000002


def response(body=None, status=200, *, raw=None):
    return SimpleNamespace(status_code=status, content=raw if raw is not None else encode_payload(body).encode())


class ScopedInspectionTransportTests(TestCase):
    def setUp(self):
        self.token = Mock(return_value='SYNTHETIC-FIXTURE-TOKEN')
        self.sender = Mock(return_value=response({'code': 200, 'data': {}}))
        self.transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
                                                     token_provider=self.token, sender=self.sender)
        self.client = ScopedInspectionReadClient(self.transport.post_json)

    def stages(self, verdict='pass'):
        return result_and_finish_plan(QC_TASK, [{'checkItemId': '10000000000000003',
            'groupName': 'SYNTHETIC-DIMENSION', 'seq': 1, 'min': Decimal('9.500'), 'max': Decimal('10.500')}], verdict=verdict)

    def authorize(self, stages):
        self.transport._write_authorization = ReviewedWriteAuthorization(
            str(QC_TASK), stages_digest(stages), 'SYNTHETIC reviewed target and values')

    def test_construction_and_default_factory_do_not_resolve_token_or_enable_mes(self):
        self.token.assert_not_called()
        self.sender.assert_not_called()
        self.assertFalse(get_inspection_adapter().enabled)
        with self.assertRaises(MesContractUnavailable):
            self.transport.send_reviewed_record(self.stages())
        self.token.assert_not_called()

    def test_existing_runtime_origin_must_match_before_token_resolution(self):
        fake_runtime = SimpleNamespace(MES_BASE_URL='https://v3-hw.blacklake.cn',
                                       get_access_token=Mock(return_value='SYNTHETIC-FIXTURE-TOKEN'))
        with patch.dict(sys.modules, {'inventory.mes': fake_runtime}):
            with self.assertRaises(MesContractUnavailable):
                existing_runtime_token('https://v3-ali.blacklake.cn')
            fake_runtime.get_access_token.assert_not_called()
            self.assertEqual(existing_runtime_token('https://v3-hw.blacklake.cn'), 'SYNTHETIC-FIXTURE-TOKEN')

    def test_explicit_read_is_exact_scoped_and_uses_existing_transport_protocol(self):
        self.client.list_first_inspections(str(WORK_ORDER))
        url, = self.sender.call_args.args
        kwargs = self.sender.call_args.kwargs
        self.assertEqual(url, 'https://v3-ali.blacklake.cn' + ROUTE_BASE + TASK_LIST)
        self.assertIn(str(WORK_ORDER).encode(), kwargs['data'])
        self.assertEqual(kwargs['params'], {'access_token': 'SYNTHETIC-FIXTURE-TOKEN'})
        self.assertEqual(kwargs['timeout'], (5, 20))
        self.assertFalse(kwargs['allow_redirects'])
        self.client.detail(str(QC_TASK))
        self.assertEqual(self.sender.call_args.kwargs['data'], encode_payload({'id': QC_TASK}).encode())

    def test_read_retains_exact_ids_decimals_and_distinct_object_enums(self):
        data = {'id': QC_TASK, 'status': {'code': 2, 'message': '已结束'},
                'checkType': {'code': 5, 'message': '巡检'}, 'quantity': Decimal('0.001')}
        self.sender.return_value = response({'code': 200, 'data': data})
        observed = self.client.detail(QC_TASK)['data']
        self.assertEqual(observed, data)
        self.assertIs(type(observed['id']), int)
        self.assertIs(type(observed['quantity']), Decimal)
        # Lifecycle code=2 is retained as an object, never mapped to the
        # finish conclusion code=2 (concession) or production-task lifecycle.
        self.assertEqual(observed['status'], data['status'])

    def test_first_and_periodic_reads_keep_response_type_separate_from_plan_name(self):
        # Same work order, distinct source QC identities/types. A historic plan
        # name containing 巡检 cannot turn an explicit 首检 response into type 5.
        first = {'id': QC_TASK, 'checkType': {'code': 3, 'message': '首检'},
                 'qcConfig': {'name': 'SYNTHETIC 巡检 historical plan'}}
        periodic = {'id': QC_TASK + 1, 'checkType': {'code': 5, 'message': '巡检'}}
        self.sender.side_effect = [response({'code': 200, 'data': {'list': [first]}}),
                                   response({'code': 200, 'data': {'list': [periodic]}})]
        self.assertEqual(self.client.list_first_inspections(WORK_ORDER)['data']['list'], [first])
        self.assertEqual(self.client.list_periodic_inspections(WORK_ORDER)['data']['list'], [periodic])
        bodies = [call.kwargs['data'] for call in self.sender.call_args_list]
        self.assertEqual(bodies, [encode_payload({'workOrderIds': [WORK_ORDER], 'checkType': kind,
                                                'page': 1, 'size': 25}).encode() for kind in (3, 5)])
        self.assertEqual(self.token.call_count, 2)
        self.assertFalse(get_inspection_adapter().enabled)

    def test_out_of_scope_or_guessed_routes_fail_before_authentication(self):
        valid = {'workOrderIds': [WORK_ORDER], 'checkType': 3, 'page': 1, 'size': 25}
        invalid = [dict(valid, workOrderIds=[WORK_ORDER + 1]), dict(valid, page=3),
                   dict(valid, size=26), dict(valid, receiveUserId=1), dict(valid, checkType=True)]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.transport.post_json(ROUTE_BASE + TASK_LIST, encode_payload(payload))
        for route, payload in [(TASK_DETAIL, {'id': QC_TASK + 1}),
                               (TASK_FINISH, {'id': QC_TASK, 'status': 1}),
                               ('/quality/open/v1/task/_save_task_check_item_and_config', {})]:
            with self.subTest(route=route), self.assertRaises(ValueError):
                self.transport.post_json(ROUTE_BASE + route, encode_payload(payload))
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_bool_and_decimal_ids_cannot_alias_integer_scope(self):
        transport = BlacklakeInspectionTransport(1, token_provider=self.token, sender=self.sender)
        for body in ['{"workOrderIds":[true],"checkType":3,"page":1,"size":25}',
                     '{"workOrderIds":[1.0],"checkType":3,"page":1,"size":25}']:
            with self.assertRaises(ValueError):
                transport.post_json(ROUTE_BASE + TASK_LIST, body)
        self.token.assert_not_called()

    def test_duplicate_nonfinite_and_unbounded_json_is_rejected_before_token(self):
        for body in ['{"id":1,"id":2}', '{"id":NaN}', 'x' * 131073]:
            with self.assertRaises(ValueError):
                self.transport.post_json(ROUTE_BASE + TASK_DETAIL, body)
        self.token.assert_not_called()

    def test_unsupported_origins_cannot_receive_existing_authentication(self):
        for origin in ['http://v3-ali.blacklake.cn', 'https://example.com',
                       'https://v3-ali.blacklake.cn/extra', 'https://user@v3-ali.blacklake.cn',
                       'https://v3-ali.blacklake.cn?access_token=x']:
            with self.assertRaises(ValueError):
                BlacklakeInspectionTransport(WORK_ORDER, origin=origin, token_provider=self.token)
        self.token.assert_not_called()

    def test_denied_http_and_business_responses_do_not_retry_or_refresh_auth(self):
        for reply in [response({}, 401), response({}, 403), response({'code': 401}), response({'code': 403})]:
            self.sender.reset_mock()
            self.token.reset_mock()
            self.sender.return_value = reply
            with self.assertRaises(MesAccessDenied):
                self.client.detail(QC_TASK)
            self.assertEqual(self.sender.call_count, 1)
            self.assertEqual(self.token.call_count, 1)

    def test_missing_authentication_sends_nothing(self):
        self.token.return_value = ''
        with self.assertRaises(MesAccessDenied):
            self.client.detail(QC_TASK)
        self.sender.assert_not_called()

    def test_timeout_202_redirect_5xx_and_malformed_responses_remain_unknown(self):
        replies = [response({}, status) for status in [202, 301, 307, 500, 503]]
        replies += [response(raw=b''), response(raw=b'not json'), response(raw=b'{}'),
                    response(raw=b'{"code":200,"code":200,"data":{}}'),
                    response(raw=b'{"code":200,"data":NaN}'), response(raw=b'x' * 524289),
                    response({'code': True, 'data': {}}), response({'code': 200, 'data': False})]
        for reply in replies:
            self.sender.reset_mock()
            self.sender.return_value = reply
            with self.subTest(status=reply.status_code), self.assertRaises(MesOutcomeUnknown):
                self.client.detail(QC_TASK)
            self.assertEqual(self.sender.call_count, 1)
        self.sender.side_effect = TimeoutError('SYNTHETIC secret URL must not appear in error')
        with self.assertRaises(MesOutcomeUnknown) as caught:
            self.client.detail(QC_TASK)
        self.assertNotIn('secret', str(caught.exception))

    def test_explicit_business_rejection_stays_rejected(self):
        for reply in [response({}, 400), response({'code': 400, 'data': {}})]:
            self.sender.return_value = reply
            with self.assertRaises(MesRejected):
                self.client.detail(QC_TASK)

    def test_weak_control_requires_human_confirmation_not_automatic_success(self):
        for need_check in [1, True, False, '1', '0', 2, {}, []]:
            self.sender.return_value = response({'code': 200, 'data': {}, 'needCheck': need_check})
            with self.subTest(need_check=need_check), self.assertRaises(MesOutcomeUnknown):
                self.client.detail(QC_TASK)
        self.sender.return_value = response({'code': 200, 'data': {}, 'needCheck': 0})
        self.assertEqual(self.client.detail(QC_TASK), {'code': 200, 'data': {}})

    def test_observed_null_confirmation_is_accepted_for_reads_only(self):
        self.sender.return_value = response({'code': 200, 'data': {}, 'needCheck': None})
        self.assertEqual(self.client.detail(QC_TASK), {'code': 200, 'data': {}})
        stages = self.stages()
        self.authorize(stages)
        self.sender.reset_mock()
        self.sender.return_value = response({'code': 200, 'data': True, 'needCheck': None})
        with self.assertRaises(MesOutcomeUnknown):
            self.transport.send_reviewed_record(stages)
        self.assertEqual(self.sender.call_count, 1)
        self.assertTrue(self.sender.call_args.args[0].endswith(ITEM_RECORD))

    def test_record_false_or_non_boolean_cannot_proceed_to_finish(self):
        for data in [False, None, 1, {}, 'true']:
            self.setUp()
            stages = self.stages()
            self.authorize(stages)
            self.sender.return_value = response({'code': 200, 'data': data})
            with self.subTest(data=data), self.assertRaises(MesOutcomeUnknown):
                self.transport.send_reviewed_record(stages)
            self.assertEqual(self.sender.call_count, 1)
            self.assertTrue(self.sender.call_args.args[0].endswith(ITEM_RECORD))

    def test_combined_save_finish_is_disabled_even_with_reviewed_authorization(self):
        stages = self.stages()
        self.authorize(stages)
        with self.assertRaises(MesContractUnavailable):
            self.transport.send_reviewed_stages(stages)
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_record_acknowledgement_never_sends_finish_and_never_replays(self):
        stages = self.stages('concession')
        self.authorize(stages)
        self.sender.return_value = response({'code': 200, 'data': True})
        ack = self.transport.send_reviewed_record(stages)
        self.assertEqual(ack.accepted_stages, 1)
        self.assertFalse(ack.completion_confirmed)
        self.assertEqual(self.sender.call_count, 1)
        self.assertTrue(self.sender.call_args.args[0].endswith(ITEM_RECORD))
        with self.assertRaises(MesOutcomeUnknown):
            self.transport.send_reviewed_record(stages)
        with self.assertRaises(MesContractUnavailable):
            self.transport.send_reviewed_stages(stages)
        self.assertEqual(self.sender.call_count, 1)

    def test_unknown_record_outcomes_never_replay_or_finish(self):
        for reply in [TimeoutError('SYNTHETIC timeout'), response({}, 202),
                      response({'code': 200, 'needCheck': 1}), response({'code': 200, 'data': False})]:
            self.setUp()
            stages = self.stages()
            self.authorize(stages)
            self.sender.side_effect = [reply]
            with self.assertRaises(MesOutcomeUnknown):
                self.transport.send_reviewed_record(stages)
            with self.assertRaises(MesOutcomeUnknown):
                self.transport.send_reviewed_record(stages)
            self.assertEqual(self.sender.call_count, 1)
            self.assertTrue(self.sender.call_args.args[0].endswith(ITEM_RECORD))

    def test_rejected_record_is_not_retried_by_the_same_transport(self):
        for status, error in [(401, MesAccessDenied), (400, MesRejected)]:
            self.setUp()
            stages = self.stages()
            self.authorize(stages)
            self.sender.return_value = response({}, status)
            with self.assertRaises(error):
                self.transport.send_reviewed_record(stages)
            with self.assertRaises(MesOutcomeUnknown):
                self.transport.send_reviewed_record(stages)
            self.assertEqual(self.sender.call_count, 1)

    def test_bad_digest_target_endpoint_or_unsupported_fields_are_rejected_before_auth(self):
        original = self.stages()
        variants = [
            [DocumentedStage('/quality/open/v1/task/_save_task_check_item_and_config', original[0].json_body), original[1]],
            [DocumentedStage(ITEM_RECORD, encode_payload({'taskId': QC_TASK, 'checkItems': [], 'skipWeakControlRule': True})), original[1]],
            [original[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK, 'status': True}))],
            [original[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK + 1, 'status': 1}))],
        ]
        for stages in variants:
            self.authorize(stages)
            with self.assertRaises(ValueError):
                self.transport.send_reviewed_record(stages)
        self.authorize(original)
        tampered = [original[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK, 'status': 4}))]
        with self.assertRaises(ValueError):
            self.transport.send_reviewed_record(tampered)
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_record_item_mapping_is_explicit_not_guessed_from_detail_ids(self):
        stages = result_and_finish_plan(QC_TASK, [{'checkItemId': '10000000000000003',
            'groupName': 'SYNTHETIC', 'seq': 1, 'result': 'MEASURED-FIXTURE'}], verdict='pass')
        self.assertIn(b'"checkItemId":10000000000000003', stages[0].json_body.encode())
        # A caller must supply the verified write ID; detail/config item IDs
        # have no automatic conversion path in this boundary.
        with self.assertRaises(ValueError):
            result_and_finish_plan(QC_TASK, [{'id': '10000000000000003', 'qcConfigCheckItemId': '4',
                'groupName': 'SYNTHETIC', 'seq': 1, 'result': 'MEASURED-FIXTURE'}], verdict='pass')

    def test_production_close_stop_and_inventory_routes_never_dispatch(self):
        for route in ['/production/task/_finish', '/work_order/_close', '/production/task/_stop', '/inventory/_inbound']:
            with self.assertRaises(ValueError):
                self.transport.post_json(ROUTE_BASE + route, encode_payload({'id': QC_TASK}))
        self.token.assert_not_called()
        self.sender.assert_not_called()
