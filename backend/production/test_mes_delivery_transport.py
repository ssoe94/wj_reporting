"""Injected synthetic senders only; no network, settings or credential issuance."""
from decimal import Decimal
from types import SimpleNamespace
import json
import sys
import unittest
from unittest.mock import Mock, patch

from quality.inspection_adapter import MesOutcomeUnknown, MesRejected
from quality.inspection_transport import (
    InspectionAccessToken, InspectionUserAccessToken, MesAccessDenied,
    MesAuthenticationExpired, MesAuthenticationMissing, MesAuthenticationRejected,
)
from production.mes_delivery_transport import (
    DeliveryReplayRejected, DeliveryScopeRejected, MesDeliveryUserTransport,
    ReviewedDeliveryAuthorization, digest_payload,
)
from production.mes_execution_contract import (
    ExactQuantity, MesExecutionTarget, build_manual_inbound,
    build_production_inventory_read, build_progress_report, build_task_start,
    encode_exact_json, parse_json_exact,
)


NOW = 2000000000
USER_ID = 9007199254740993
TOKEN = 'SYNTHETIC-TOKEN-NEVER-REAL'
CODE = 'WJ-SYNTHETIC-ONLY'


def lease(**changes):
    values = dict(value=TOKEN, expires_at=NOW + 500, user_id=USER_ID)
    values.update(changes)
    return InspectionUserAccessToken(**values)


def target():
    return MesExecutionTarget(9007199254740995, CODE, 9007199254740997,
                              9007199254740999, 9007199254741001, 9007199254741003)


def quantity(amount='1.2345678901'):
    return ExactQuantity(amount, 9007199254741005, 10)


def response(data=None, *, status=200, **changes):
    body = dict(code=200, needCheck=0, data={} if data is None else data, message=TOKEN)
    body.update(changes)
    return SimpleNamespace(status_code=status, content=encode_exact_json(body), history=[])


def authorization(action_name, payload, **changes):
    values = dict(actor_id=18, tenant='synthetic-tenant', work_order_code=CODE,
                  action=action_name, payload_sha=digest_payload(payload),
                  verification_reference='synthetic-review/1', expires_at=NOW + 300)
    values.update(changes)
    return ReviewedDeliveryAuthorization(**values)


def transport(sender, **changes):
    values = dict(origin='https://v3-ali.blacklake.cn', actor_id=18,
                  tenant='synthetic-tenant', work_order_code=CODE,
                  expected_mes_user_id=USER_ID, sender=sender, clock=lambda: NOW)
    values.update(changes)
    return MesDeliveryUserTransport(**values)


class DeliveryTransportTests(unittest.TestCase):
    def call_start(self, client, *, auth=None, credential=None):
        payload = build_task_start(target().task_id)
        return client.call('task_start', payload, auth or authorization('task_start', payload),
                           lease() if credential is None else credential)

    def test_explicit_user_fixed_origin_route_and_no_redirect(self):
        sender = Mock(return_value=response())
        client = transport(sender)
        checked = self.call_start(client)
        self.assertEqual(checked, {'code': 200, 'needCheck': 0, 'data': {}})
        args, kwargs = sender.call_args
        self.assertEqual(args, ('https://v3-ali.blacklake.cn/api/openapi/domain/web/v1/route/mfg/app/v1/produce_task/_start',))
        self.assertEqual(kwargs['params'], {'access_token': TOKEN})
        self.assertEqual(kwargs['headers'], {'Content-Type': 'application/json'})
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['timeout'], (5, 20))
        self.assertTrue(client.dispatched)
        self.assertTrue(client.readback_required)
        self.assertEqual(client.status_flag, 'acknowledged')
        self.assertFalse(client.readback_allowed_after_error)

    def test_alternate_documented_origin(self):
        sender = Mock(return_value=response())
        self.call_start(transport(sender, origin='https://v3-hw.blacklake.cn'))
        self.assertTrue(sender.call_args.args[0].startswith('https://v3-hw.blacklake.cn/'))

    def test_origin_injection_is_rejected_at_construction(self):
        for origin in ('http://v3-ali.blacklake.cn', 'https://v3-ali.blacklake.cn/',
                       'https://v3-ali.blacklake.cn:443', 'https://v3-ali.blacklake.cn/path',
                       'https://v3-ali.blacklake.cn?token=secret', 'https://v3-ali.blacklake.cn@evil.invalid',
                       'https://evil.invalid', ['https://v3-ali.blacklake.cn']):
            with self.subTest(origin=origin), self.assertRaises(DeliveryScopeRejected):
                transport(Mock(), origin=origin)

    def test_default_sender_is_lazy_and_receives_only_explicit_lease(self):
        sender = Mock(return_value=response())
        fake = SimpleNamespace(_user_sender=sender)
        with patch.dict(sys.modules, {'quality.inspection_live_adapter': fake}):
            client = transport(None)
            sender.assert_not_called()
            self.call_start(client)
        self.assertEqual(sender.call_args.kwargs['params'], {'access_token': TOKEN})

    def test_no_missing_legacy_or_other_user_credential_fallback(self):
        for credential, error in ((InspectionAccessToken(TOKEN, NOW + 500), MesAuthenticationMissing),
                                  ('some token', MesAuthenticationMissing),
                                  (lease(value=''), MesAuthenticationMissing),
                                  (lease(value='synthetic\nheader'), MesAuthenticationMissing),
                                  (lease(user_id=USER_ID + 2), MesAuthenticationRejected),
                                  (lease(expires_at=NOW), MesAuthenticationExpired)):
            sender = Mock()
            client = transport(sender)
            with self.subTest(error=error.__name__), self.assertRaises(error):
                self.call_start(client, credential=credential)
            sender.assert_not_called()
            self.assertFalse(client.dispatched)
            self.assertFalse(client.readback_allowed_after_error)

    def test_authorization_actor_tenant_code_action_digest_and_expiry_bound(self):
        payload = build_task_start(target().task_id)
        for change in ({'actor_id': 19}, {'tenant': 'other-tenant'}, {'work_order_code': 'OTHER'},
                       {'action': 'manual_inbound'}, {'payload_sha': 'f' * 64}, {'expires_at': NOW}):
            sender = Mock()
            client = transport(sender)
            auth = authorization('task_start', payload, **change)
            with self.subTest(change=change), self.assertRaises(DeliveryScopeRejected):
                self.call_start(client, auth=auth)
            sender.assert_not_called()
            self.assertEqual(client.status_flag, 'scope_rejected')

    def test_bad_authorization_fields_do_not_construct_permission(self):
        payload = build_task_start(target().task_id)
        for change in ({'actor_id': True}, {'tenant': '../?secret'}, {'action': ['task_start']},
                       {'payload_sha': 'ABC'}, {'verification_reference': ' bad '},
                       {'expires_at': float('nan')}, {'expires_at': True}):
            with self.subTest(change=str(change)), self.assertRaises(DeliveryScopeRejected):
                authorization('task_start', payload, **change)

    def test_expiry_rechecked_immediately_before_dispatch(self):
        for clock, expected in ((Mock(side_effect=[NOW, NOW + 301]), DeliveryScopeRejected),
                                (Mock(side_effect=[NOW, NOW + 501]), DeliveryScopeRejected)):
            sender = Mock()
            client = transport(sender, clock=clock)
            with self.assertRaises(expected):
                self.call_start(client)
            sender.assert_not_called()

    def test_credential_expiry_rechecked_with_still_current_authorization(self):
        sender = Mock()
        client = transport(sender, clock=Mock(side_effect=[NOW, NOW + 100]))
        with self.assertRaises(MesAuthenticationExpired):
            self.call_start(client, credential=lease(expires_at=NOW + 50))
        sender.assert_not_called()

    def test_generic_url_or_unreviewed_changed_payload_cannot_dispatch(self):
        for action in ('https://evil.invalid', '/mfg/app/v1/produce_task/_start', 'finish_qc', []):
            sender = Mock()
            client = transport(sender)
            payload = build_task_start(target().task_id)
            with self.subTest(action=action), self.assertRaises(DeliveryScopeRejected):
                client.call(action, payload, authorization('task_start', payload), lease())
            sender.assert_not_called()
        sender = Mock()
        client = transport(sender)
        payload = build_task_start(target().task_id)
        auth = authorization('task_start', payload)
        payload['taskId'] += 2
        with self.assertRaises(DeliveryScopeRejected):
            client.call('task_start', payload, auth, lease())
        sender.assert_not_called()

    def test_task_body_ids_and_sop_control_not_coerced(self):
        for payload in ({'taskId': str(target().task_id), 'alsoStartSopTaskFlag': False},
                        {'taskId': target().task_id, 'alsoStartSopTaskFlag': True},
                        {'taskId': target().task_id, 'alsoStartSopTaskFlag': 0},
                        {'taskId': target().task_id, 'alsoStartSopTaskFlag': False, 'skipWeakControlRule': []}):
            sender = Mock()
            with self.subTest(payload=payload), self.assertRaises(DeliveryScopeRejected):
                transport(sender).call('task_start', payload, authorization('task_start', payload), lease())
            sender.assert_not_called()

    def test_one_write_per_action_even_after_new_review_reference(self):
        sender = Mock(return_value=response())
        client = transport(sender)
        self.call_start(client)
        payload = build_task_start(target().task_id)
        auth = authorization('task_start', payload, verification_reference='synthetic-review/2')
        with self.assertRaises(DeliveryReplayRejected):
            self.call_start(client, auth=auth)
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(client.status_flag, 'replay_blocked')

    def test_timeout_has_one_consumable_readback_allowance_no_retry(self):
        sender = Mock(side_effect=TimeoutError(TOKEN))
        client = transport(sender)
        with self.assertRaises(MesOutcomeUnknown) as caught:
            self.call_start(client)
        self.assertEqual(str(caught.exception), '')
        self.assertEqual(sender.call_count, 1)
        self.assertTrue(client.dispatched)
        self.assertTrue(client.readback_allowed_after_error)
        self.assertTrue(client.consume_readback_allowance())
        self.assertFalse(client.consume_readback_allowance())
        with self.assertRaises(DeliveryReplayRejected):
            self.call_start(client)
        self.assertEqual(sender.call_count, 1)

    def test_ambiguous_http_and_redirects_allow_readback_without_following(self):
        for status in (202, 301, 307, 408, 500, 503):
            sender = Mock(return_value=response(status=status))
            client = transport(sender)
            with self.subTest(status=status), self.assertRaises(MesOutcomeUnknown):
                self.call_start(client)
            self.assertTrue(client.readback_allowed_after_error)
            self.assertEqual(sender.call_count, 1)
            self.assertFalse(sender.call_args.kwargs['allow_redirects'])
        redirected = response()
        redirected.history = [SimpleNamespace(status_code=302)]
        client = transport(Mock(return_value=redirected))
        with self.assertRaises(MesOutcomeUnknown):
            self.call_start(client)
        self.assertTrue(client.readback_allowed_after_error)

    def test_known_http_auth_or_rejection_prohibits_automatic_readback(self):
        for status, error in ((401, MesAuthenticationRejected), (403, MesAccessDenied),
                              (400, MesRejected), (409, MesRejected), (429, MesRejected)):
            client = transport(Mock(return_value=response(status=status)))
            with self.subTest(status=status), self.assertRaises(error):
                self.call_start(client)
            self.assertTrue(client.dispatched)
            self.assertFalse(client.readback_allowed_after_error)

    def test_known_business_auth_or_rejection_prohibits_readback(self):
        for code, error in ((401, MesAuthenticationRejected), (403, MesAccessDenied), (100001, MesRejected)):
            client = transport(Mock(return_value=response(code=code)))
            with self.subTest(code=code), self.assertRaises(error) as caught:
                self.call_start(client)
            self.assertEqual(str(caught.exception), '')
            self.assertFalse(client.readback_allowed_after_error)

    def test_confirmation_nonzero_or_noninteger_never_auto_confirms(self):
        for value in (1, 2, -1, True, '0', 0.0):
            body = json.dumps({'code': 200, 'needCheck': value, 'data': {}}).encode()
            client = transport(Mock(return_value=SimpleNamespace(status_code=200, content=body)))
            with self.subTest(value=value), self.assertRaises(MesOutcomeUnknown):
                self.call_start(client)
            self.assertFalse(client.readback_allowed_after_error)
            self.assertEqual(client.status_flag, 'confirmation_required')

    def test_omitted_or_null_confirmation_is_unknown_with_readback(self):
        for body in ({'code': 200, 'data': {}}, {'code': 200, 'needCheck': None, 'data': {}}):
            client = transport(Mock(return_value=SimpleNamespace(status_code=200, content=encode_exact_json(body))))
            with self.assertRaises(MesOutcomeUnknown):
                self.call_start(client)
            self.assertTrue(client.readback_allowed_after_error)

    def test_malformed_duplicate_nonfinite_or_oversized_response_never_acks(self):
        for content in (b'', b'{"code":200,"code":500,"needCheck":0,"data":{}}',
                        b'{"code":200,"needCheck":0,"data":{"x":NaN}}', b'\xff',
                        b'x' * 524289, '{"code":200}', b'{"code":true,"needCheck":0,"data":{}}'):
            client = transport(Mock(return_value=SimpleNamespace(status_code=200, content=content)))
            with self.subTest(size=len(content)), self.assertRaises(MesOutcomeUnknown):
                self.call_start(client)
            self.assertTrue(client.readback_allowed_after_error)

    def test_sender_known_error_is_sanitized_and_blocks_readback(self):
        client = transport(Mock(side_effect=MesAccessDenied(TOKEN)))
        with self.assertRaises(MesAccessDenied) as caught:
            self.call_start(client)
        self.assertEqual(str(caught.exception), '')
        self.assertFalse(client.readback_allowed_after_error)

    def test_exact_decimal_and_large_ids_on_report_and_inbound_wire(self):
        report = build_progress_report(target(), quantity=quantity(), executor_ids=[USER_ID],
                                      report_type=7, allowed_report_types=(7,), qc_status=1, remark='SYNTHETIC ONLY')
        inbound = build_manual_inbound(target(), production_inventory_id=9007199254741007,
            quantity=quantity(), available_quantity=quantity('2'), storage_location_id=9007199254741009,
            approved_storage_location_id=9007199254741009, qc_status=1, remark='SYNTHETIC ONLY')
        for action, payload, data in (('progress_report', report, {'messageTraceId': 9007199254741011,
            'progressReportRecordIds': [9007199254741013], 'queryInventoryResult': True}), ('manual_inbound', inbound, {})):
            sender = Mock(return_value=response(data))
            client = transport(sender)
            client.call(action, payload, authorization(action, payload), lease())
            wire = sender.call_args.kwargs['data']
            self.assertIn(b'1.2345678901', wire)
            self.assertNotIn(b'"1.2345678901"', wire)
            self.assertIn(b'9007199254741005', wire)
            self.assertTrue(client.readback_required)
            self.assertEqual(parse_json_exact(wire)['taskId'], target().task_id)

    def test_read_requires_its_own_digest_and_exact_bounded_task_body(self):
        payload = build_production_inventory_read(target())
        for change in ({'page': 3}, {'size': 26}, {'taskId': str(target().task_id)},
                       {'amountFilterFlag': True}, {'quickSearch': 'broadened'}):
            invalid = {**payload, **change}
            sender = Mock()
            with self.subTest(change=change), self.assertRaises(DeliveryScopeRejected):
                transport(sender).call('production_inventory_list', invalid,
                    authorization('production_inventory_list', invalid), lease())
            sender.assert_not_called()

    def test_read_output_strips_secret_and_unrelated_fields(self):
        payload = build_production_inventory_read(target())
        data = {'page': 1, 'total': 1, 'access_token': TOKEN, 'list': [{
            'id': 9007199254741007, 'lineId': target().line_id, 'secret': TOKEN,
            'materialVO': {'baseInfo': {'id': target().material_id, 'remark': TOKEN}},
            'amount': {'amount': Decimal('2'), 'unitId': quantity().unit_id, 'amountDisplay': TOKEN},
            'virtualMaterialFlag': False, 'qcStatus': {'code': 1, 'message': TOKEN},
        }]}
        client = transport(Mock(return_value=response(data)))
        checked = client.call('production_inventory_list', payload,
                              authorization('production_inventory_list', payload), lease())
        self.assertNotIn(TOKEN, repr(checked))
        self.assertEqual(checked['data']['list'][0]['amount']['amount'], 2)
        self.assertFalse(client.readback_required)
        self.assertEqual(client.status_flag, 'read_verified')

    def test_failed_read_never_creates_an_automatic_readback_budget(self):
        payload = {'taskId': target().task_id}
        client = transport(Mock(side_effect=TimeoutError(TOKEN)))
        with self.assertRaises(MesOutcomeUnknown):
            client.call('reportable_materials', payload, authorization('reportable_materials', payload), lease())
        self.assertFalse(client.readback_allowed_after_error)
        self.assertFalse(client.consume_readback_allowance())

    def test_malformed_business_receipt_is_unknown_not_preflight_scope_error(self):
        payload = {'dispatchRequests': [{'workOrderCode': CODE, 'workOrderId': target().work_order_id,
            'plannedAmount': Decimal(1), 'plannedStartTime': NOW * 1000, 'plannedFinishTime': (NOW + 60) * 1000,
            'processNum': '10', 'produceTaskCode': 'SYNTHETIC-TASK', 'taskIdentifier': 'SYNTHETIC-TASK-IDENTIFIER',
            'remark': 'SYNTHETIC ONLY', 'resourceGroupList': [{'bizType': 1, 'groupType': 1, 'lineNo': 10,
                'name': 'synthetic group', 'bizOpenCOList': [{'bizId': USER_ID, 'bizCode': 'SYNTHETIC', 'bizType': 1}]}]}]}
        client = transport(Mock(return_value=response({'id': 'NOT-AN-ID'})))
        with self.assertRaises(MesOutcomeUnknown):
            client.call('work_order_dispatch', payload, authorization('work_order_dispatch', payload), lease())
        self.assertTrue(client.readback_allowed_after_error)

    def test_reportable_read_strips_secret_messages_and_preserves_exact_contract(self):
        payload = {'taskId': target().task_id}
        data = {'outputMaterials': [{
            'progressReportKey': {'materialId': target().material_id, 'lineId': target().line_id,
                                  'reportProcessId': target().report_process_id, 'secret': TOKEN},
            'warehousingFlag': True, 'autoWarehousingFlag': False, 'virtualMaterialFlag': False, 'mainFlag': True,
            'outputMaterialUnit': {'id': quantity().unit_id, 'precisionFigure': 10, 'remark': TOKEN,
                                   'enableFlag': {'code': 1, 'message': TOKEN}, 'enablePrecision': {'code': 1}},
            'reportType': [{'code': 7, 'message': TOKEN}], 'materialInfo': {'remark': TOKEN},
        }]}
        client = transport(Mock(return_value=response(data)))
        checked = client.call('reportable_materials', payload, authorization('reportable_materials', payload), lease())
        self.assertNotIn(TOKEN, repr(checked))
        self.assertEqual(checked['data']['outputMaterials'][0]['reportType'], [{'code': 7}])

    def test_malformed_read_business_fields_cannot_leak_as_checked_data(self):
        payload = build_production_inventory_read(target())
        data = {'page': 1, 'total': 1, 'list': [{'id': 'INVALID', 'lineId': target().line_id,
            'materialVO': {'baseInfo': {'id': target().material_id}},
            'amount': {'amount': TOKEN, 'unitId': quantity().unit_id},
            'virtualMaterialFlag': False, 'qcStatus': {'code': 1}}]}
        client = transport(Mock(return_value=response(data)))
        with self.assertRaises(MesOutcomeUnknown) as caught:
            client.call('production_inventory_list', payload, authorization('production_inventory_list', payload), lease())
        self.assertEqual(str(caught.exception), '')
        self.assertFalse(client.readback_allowed_after_error)

    def test_read_call_clears_previous_write_unknown_allowance(self):
        sender = Mock(side_effect=[TimeoutError(TOKEN), response({'page': 1, 'total': 0, 'list': []})])
        client = transport(sender)
        with self.assertRaises(MesOutcomeUnknown):
            self.call_start(client)
        self.assertTrue(client.readback_allowed_after_error)
        payload = build_production_inventory_read(target())
        client.call('production_inventory_list', payload, authorization('production_inventory_list', payload), lease())
        self.assertFalse(client.readback_allowed_after_error)
        self.assertFalse(client.readback_required)
        self.assertEqual(sender.call_count, 2)


if __name__ == '__main__':
    unittest.main()
