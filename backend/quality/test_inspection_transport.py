"""Document contract fixtures only: no real token, network, tenant or QC writes."""
from dataclasses import replace
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
from .inspection_transport import (
    BlacklakeInspectionTransport, InspectionAccessToken, InspectionUserAccessToken, MesAccessDenied,
    MesAuthenticationExpired, MesAuthenticationMissing, MesAuthenticationRejected,
    ReviewedFinishAuthorization, ReviewedWriteAuthorization, existing_runtime_token, stages_digest,
)


WORK_ORDER = 10000000000000001
QC_TASK = 10000000000000002
ELIGIBILITY_USER = 10000000000000004


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
        with self.assertRaises(MesAuthenticationMissing):
            self.client.detail(QC_TASK)
        self.sender.assert_not_called()

    def test_missing_expired_401_and_403_are_distinct_without_refresh_or_retry(self):
        cases = [('', None, MesAuthenticationMissing, 0),
                 (InspectionAccessToken('SYNTHETIC-FIXTURE-TOKEN', 99), None, MesAuthenticationExpired, 0),
                 ('SYNTHETIC-FIXTURE-TOKEN', response({}, 401), MesAuthenticationRejected, 1),
                 ('SYNTHETIC-FIXTURE-TOKEN', response({'code': 401}), MesAuthenticationRejected, 1),
                 ('SYNTHETIC-FIXTURE-TOKEN', response({}, 403), MesAccessDenied, 1),
                 ('SYNTHETIC-FIXTURE-TOKEN', response({'code': 403}), MesAccessDenied, 1)]
        for credential, reply, error, sends in cases:
            self.token.reset_mock()
            self.sender.reset_mock()
            self.token.return_value = credential
            self.sender.return_value = reply
            with self.subTest(error=error.code), patch('quality.inspection_transport.time.time', return_value=100):
                with self.assertRaises(error) as raised:
                    self.client.detail(QC_TASK)
                self.assertIs(type(raised.exception), error)
                self.assertNotIn('SYNTHETIC-FIXTURE-TOKEN', str(raised.exception))
            self.assertEqual(self.token.call_count, 1)
            self.assertEqual(self.sender.call_count, sends)

    def test_optional_expiry_preserves_protocol_and_never_exposes_token_in_repr(self):
        credential = InspectionAccessToken('SYNTHETIC-FIXTURE-TOKEN', 101)
        self.assertNotIn('SYNTHETIC-FIXTURE-TOKEN', repr(credential))
        self.token.return_value = credential
        with patch('quality.inspection_transport.time.time', return_value=100):
            self.client.detail(QC_TASK)
        self.assertEqual(self.sender.call_args.kwargs['params']['access_token'], 'SYNTHETIC-FIXTURE-TOKEN')
        for expiry in (True, '100', float('nan'), float('inf')):
            with self.subTest(expiry=expiry), self.assertRaises(ValueError):
                InspectionAccessToken('SYNTHETIC-FIXTURE-TOKEN', expiry)

    def test_eligibility_comparison_binds_one_subject_and_does_not_grant_write_authority(self):
        self.transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
            eligibility_user_id=ELIGIBILITY_USER, token_provider=self.token, sender=self.sender)
        client = ScopedInspectionReadClient(self.transport.post_json)
        self.sender.return_value = response({'code': 200, 'data': {'id': QC_TASK, 'getAble': 1}})
        self.assertEqual(client.detail(QC_TASK)['data']['getAble'], 1)
        self.assertEqual(client.detail(QC_TASK, eligibility_user_id=ELIGIBILITY_USER)['data']['getAble'], 1)
        self.assertEqual([call.kwargs['data'] for call in self.sender.call_args_list], [
            encode_payload({'id': QC_TASK}).encode(),
            encode_payload({'id': QC_TASK, 'receiveUserId': ELIGIBILITY_USER}).encode()])
        stages = self.stages()
        self.authorize(stages)
        with self.assertRaises(MesContractUnavailable):
            self.transport.send_reviewed_record(stages)
        with self.assertRaises(MesContractUnavailable):
            self.transport.send_reviewed_stages(stages)
        self.assertEqual(self.sender.call_count, 2)
        self.assertEqual(self.token.call_count, 2)
        self.assertFalse(get_inspection_adapter().enabled)

    def test_eligibility_scope_rejects_unreviewed_subjects_routes_and_coercions_before_auth(self):
        transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
            eligibility_user_id=ELIGIBILITY_USER, token_provider=self.token, sender=self.sender)
        for payload in ({'id': QC_TASK, 'receiveUserId': ELIGIBILITY_USER + 1},
                        {'id': QC_TASK + 1, 'receiveUserId': ELIGIBILITY_USER},
                        {'id': QC_TASK, 'receiveUserId': str(ELIGIBILITY_USER)},
                        {'id': QC_TASK, 'receiveUserId': True},
                        {'id': QC_TASK, 'receiveUserId': Decimal(ELIGIBILITY_USER)},
                        {'id': QC_TASK, 'receiveUserId': None},
                        {'id': QC_TASK, 'receiveUserId': ELIGIBILITY_USER, 'skipWeakControlRule': True}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                transport.post_json(ROUTE_BASE + TASK_DETAIL, encode_payload(payload))
        for route in (TASK_LIST, TASK_FINISH, ITEM_RECORD, '/quality/open/v1/task/_get_task'):
            with self.subTest(route=route), self.assertRaises(ValueError):
                transport.post_json(ROUTE_BASE + route, encode_payload({'id': QC_TASK}))
        with self.assertRaises(ValueError):
            self.client.detail(QC_TASK, eligibility_user_id=ELIGIBILITY_USER)
        with self.assertRaises(ValueError):
            BlacklakeInspectionTransport(WORK_ORDER, eligibility_user_id=ELIGIBILITY_USER)
        with self.assertRaises(ValueError):
            BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK, eligibility_user_id=ELIGIBILITY_USER,
                write_authorization=ReviewedWriteAuthorization(str(QC_TASK), 'fixture', 'fixture'))
        self.token.assert_not_called()
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


class ReviewedInspectionFinishTransportTests(TestCase):
    """Fresh adapter evidence and an injected user credential; never a live call."""

    def setUp(self):
        self.now = 1000
        clock = patch('quality.inspection_transport.time.time', side_effect=lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.stages = result_and_finish_plan(QC_TASK, [{
            'checkItemId': '10000000000000003', 'groupName': 'SYNTHETIC',
            'seq': 1, 'result': 'SYNTHETIC-MEASURED'}], verdict='pass')
        self.authorization = ReviewedFinishAuthorization(
            str(QC_TASK), stages_digest(self.stages), 'SYNTHETIC reviewed saved readback',
            'saved', ELIGIBILITY_USER, ELIGIBILITY_USER, 'a' * 64, 999)
        self.token = Mock(return_value=InspectionUserAccessToken(
            'SYNTHETIC-USER-TOKEN', 2000, user_id=ELIGIBILITY_USER))
        self.sender = Mock(return_value=response({'code': 200, 'data': None}))
        self.transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
            token_provider=self.token, sender=self.sender)

    def finish(self, transport=None, *, stages=None, authorization=None):
        return (transport or self.transport).send_reviewed_finish(
            self.stages if stages is None else stages,
            authorization=self.authorization if authorization is None else authorization)

    def test_only_finish_is_sent_once_and_ack_requires_fresh_completion_readback(self):
        ack = self.finish()
        self.assertEqual(ack.accepted_stages, 1)
        self.assertFalse(ack.completion_confirmed)
        self.assertTrue(ack.readback_required)
        self.token.assert_called_once_with()
        self.sender.assert_called_once()
        self.assertEqual(self.sender.call_args.args,
                         ('https://v3-ali.blacklake.cn' + ROUTE_BASE + TASK_FINISH,))
        self.assertEqual(self.sender.call_args.kwargs['data'], self.stages[1].json_body.encode())
        self.assertEqual(self.sender.call_args.kwargs['params'], {'access_token': 'SYNTHETIC-USER-TOKEN'})
        self.assertFalse(self.sender.call_args.kwargs['allow_redirects'])
        with self.assertRaises(MesOutcomeUnknown):
            self.finish()
        self.assertEqual(self.token.call_count, 1)
        self.assertEqual(self.sender.call_count, 1)

    def test_record_and_finish_have_independent_guards_and_combined_stays_disabled(self):
        self.transport._write_authorization = ReviewedWriteAuthorization(
            str(QC_TASK), stages_digest(self.stages), 'SYNTHETIC approved record')
        self.sender.return_value = response({'code': 200, 'data': True})
        self.transport.send_reviewed_record(self.stages)
        self.finish()
        self.assertEqual([call.args[0].rsplit('/', 1)[-1] for call in self.sender.call_args_list],
                         ['_update_task_check_item', '_finish'])
        for operation in (lambda: self.transport.send_reviewed_record(self.stages), self.finish):
            with self.assertRaises(MesOutcomeUnknown):
                operation()
        with self.assertRaises(MesContractUnavailable):
            self.transport.send_reviewed_stages(self.stages)
        self.assertEqual(self.sender.call_count, 2)

    def test_default_inventory_provider_and_eligibility_only_transport_cannot_finish(self):
        default = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK, sender=self.sender)
        readonly = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
            token_provider=self.token, sender=self.sender, eligibility_user_id=ELIGIBILITY_USER)
        with patch('quality.inspection_transport.existing_runtime_token') as fallback:
            for transport in (default, readonly):
                with self.assertRaises(MesContractUnavailable):
                    self.finish(transport)
            fallback.assert_not_called()
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_finish_requires_its_own_readback_authorization_not_record_review(self):
        for authorization in (None, {}, ReviewedWriteAuthorization(
                str(QC_TASK), stages_digest(self.stages), 'SYNTHETIC record-only')):
            with self.subTest(kind=type(authorization).__name__), self.assertRaises(MesContractUnavailable):
                self.transport.send_reviewed_finish(self.stages, authorization=authorization)
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_malformed_saved_evidence_is_rejected_without_token_resolution(self):
        variants = [dict(phase=value) for value in ('ready', 'save_unknown', 'completed', True)]
        variants += [dict(source_evidence_digest=value) for value in ('', 'x' * 64, 'a' * 63, True)]
        variants += [dict(observed_at=value) for value in (None, True, '999', float('inf'), float('nan'))]
        variants += [dict(actor_user_id=True), dict(credential_user_id=ELIGIBILITY_USER + 1),
                     dict(actor_user_id=0, credential_user_id=0), dict(verification_reference=''),
                     dict(verification_reference='x' * 501), dict(verification_reference=' ' * 501 + 'x'),
                     dict(payload_digest='')]
        for changes in variants:
            with self.subTest(fields=list(changes)), self.assertRaises(ValueError):
                replace(self.authorization, **changes)
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_digest_qc_scope_exact_bytes_and_route_are_checked_before_auth(self):
        cases = [(self.stages, replace(self.authorization, qc_task_id=str(QC_TASK + 1))),
                 (self.stages, replace(self.authorization, payload_digest='b' * 64))]
        variants = [
            [self.stages[1], self.stages[0]],
            [self.stages[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK + 1, 'status': 1}))],
            [self.stages[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK, 'status': True}))],
            [self.stages[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK, 'status': 1, 'receiveUserId': ELIGIBILITY_USER}))],
            [self.stages[0], DocumentedStage('/production/task/_finish', self.stages[1].json_body)],
            [DocumentedStage(ITEM_RECORD, encode_payload({'taskId': QC_TASK + 1, 'checkItems': []})), self.stages[1]],
        ]
        cases += [(stages, replace(self.authorization, payload_digest=stages_digest(stages))) for stages in variants]
        for stages, authorization in cases:
            with self.subTest(), self.assertRaises(ValueError):
                self.finish(stages=stages, authorization=authorization)
        altered = [self.stages[0], DocumentedStage(TASK_FINISH, encode_payload({'id': QC_TASK, 'status': 4}))]
        with self.assertRaises(ValueError):
            self.finish(stages=altered)
        self.token.assert_not_called()
        self.sender.assert_not_called()

    def test_future_and_expired_readback_block_before_auth_but_sixty_seconds_is_valid(self):
        for observed_at in (1000.001, 939.999):
            with self.subTest(observed_at=observed_at), self.assertRaises(MesContractUnavailable):
                self.finish(authorization=replace(self.authorization, observed_at=observed_at))
        self.token.assert_not_called()
        self.sender.assert_not_called()
        self.finish(authorization=replace(self.authorization, observed_at=940))
        self.sender.assert_called_once()

    def test_slow_token_resolution_cannot_use_a_stale_saved_readback(self):
        def resolve():
            self.now = 1060  # Saved readback at 999 is now 61 seconds old.
            return InspectionUserAccessToken('SYNTHETIC-USER-TOKEN', 2000, user_id=ELIGIBILITY_USER)
        self.token.side_effect = resolve
        with self.assertRaises(MesContractUnavailable):
            self.finish()
        self.token.assert_called_once_with()
        self.sender.assert_not_called()

    def test_plain_app_unknown_expiry_and_other_user_credentials_cannot_finish(self):
        invalid = ['SYNTHETIC-APP-TOKEN', InspectionAccessToken('SYNTHETIC-APP-TOKEN', 2000),
                   InspectionUserAccessToken('SYNTHETIC-OTHER-USER', 2000, user_id=ELIGIBILITY_USER + 1)]
        for credential in invalid:
            token = Mock(return_value=credential)
            transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
                token_provider=token, sender=self.sender)
            with self.assertRaises(MesAuthenticationRejected):
                self.finish(transport)
            token.assert_called_once_with()
        self.sender.assert_not_called()
        for expiry in (None, True, '2000', float('inf'), float('nan')):
            with self.subTest(expiry=expiry), self.assertRaises(ValueError):
                InspectionUserAccessToken('SYNTHETIC', expiry, user_id=ELIGIBILITY_USER)
        with self.assertRaises(TypeError):
            InspectionUserAccessToken('SYNTHETIC', user_id=ELIGIBILITY_USER)
        with self.assertRaises(ValueError):
            InspectionUserAccessToken('SYNTHETIC', 2000, user_id=True)

    def test_user_credential_is_reusable_for_scoped_reads_and_never_revealed_in_repr(self):
        credential = self.token.return_value
        self.assertNotIn('SYNTHETIC-USER-TOKEN', repr(credential))
        self.sender.return_value = response({'code': 200, 'data': {'id': QC_TASK}})
        ScopedInspectionReadClient(self.transport.post_json).detail(QC_TASK)
        self.token.assert_called_once_with()
        self.assertEqual(self.sender.call_args.kwargs['params'], {'access_token': 'SYNTHETIC-USER-TOKEN'})

    def test_expired_or_missing_user_token_never_sends_and_cannot_retry(self):
        for credential, expected in [
                (InspectionUserAccessToken('SYNTHETIC', 1000, user_id=ELIGIBILITY_USER), MesAuthenticationExpired),
                (InspectionUserAccessToken('', 2000, user_id=ELIGIBILITY_USER), MesAuthenticationMissing)]:
            token = Mock(return_value=credential)
            transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
                token_provider=token, sender=self.sender)
            with self.assertRaises(expected):
                self.finish(transport)
            with self.assertRaises(MesOutcomeUnknown):
                self.finish(transport)
            token.assert_called_once_with()
        self.sender.assert_not_called()

    def test_finish_failures_never_retry_refresh_fallback_or_expose_provider_details(self):
        cases = [(response({}, 401), MesAuthenticationRejected), (response({}, 403), MesAccessDenied),
                 (response({}, 400), MesRejected), (response({'code': 401}), MesAuthenticationRejected),
                 (response({'code': 403}), MesAccessDenied)]
        cases += [(reply, MesOutcomeUnknown) for reply in (
            TimeoutError('SYNTHETIC credential and provider error'), response({}, 202), response({}, 302),
            response({}, 500), response(raw=b'not-json'), response({'code': 200, 'needCheck': 1}),
            response({'code': 200, 'needCheck': None}), response({'code': 200, 'needCheck': True}))]
        for reply, expected in cases:
            token = Mock(return_value=self.token.return_value)
            sender = Mock(side_effect=[reply])
            transport = BlacklakeInspectionTransport(WORK_ORDER, qc_task_id=QC_TASK,
                token_provider=token, sender=sender)
            with self.subTest(expected=expected.__name__), self.assertRaises(expected) as caught:
                self.finish(transport)
            self.assertNotIn('SYNTHETIC', str(caught.exception))
            with self.assertRaises(MesOutcomeUnknown):
                self.finish(transport)
            token.assert_called_once_with()
            sender.assert_called_once()

    def test_token_provider_failure_never_falls_back_or_dispatches(self):
        self.token.side_effect = RuntimeError('SYNTHETIC secret provider diagnostic')
        with patch('quality.inspection_transport.existing_runtime_token') as fallback:
            with self.assertRaises(MesOutcomeUnknown) as caught:
                self.finish()
            self.assertNotIn('SYNTHETIC', str(caught.exception))
            with self.assertRaises(MesOutcomeUnknown):
                self.finish()
            fallback.assert_not_called()
        self.token.assert_called_once_with()
        self.sender.assert_not_called()
