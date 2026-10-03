import json
from decimal import Decimal
from unittest.mock import Mock

from unittest import TestCase

from .inspection_blacklake_contract import ScopedInspectionReadClient, encode_payload, mes_id, result_and_finish_plan


class DocumentedBlacklakeContractTests(TestCase):
    def test_large_ids_are_exact_on_wire(self):
        transport = Mock(return_value={'data': {}})
        client = ScopedInspectionReadClient(transport)
        client.list_first_inspections('10000000000000001')
        route, body = transport.call_args.args
        self.assertTrue(route.endswith('/quality/open/v1/task/_list'))
        self.assertEqual(json.loads(body)['workOrderIds'], [10000000000000001])
        self.assertEqual(json.loads(body)['checkType'], 3)

    def test_lookup_is_scoped_and_bounded(self):
        client = ScopedInspectionReadClient(Mock())
        for args in [('', 1, 25), ('1', 3, 25), ('1', 1, 26)]:
            with self.assertRaises(ValueError):
                client.list_first_inspections(args[0], page=args[1], size=args[2])
        for value in [True, 1.0, '1e16', '0001', '-1', '9223372036854775808']:
            with self.assertRaises(ValueError):
                mes_id(value)

    def test_documented_detail_does_not_override_actor(self):
        transport = Mock()
        client = ScopedInspectionReadClient(transport)
        client.detail('10000000000000001')
        self.assertEqual(json.loads(transport.call_args.args[1]), {'id': 10000000000000001})
        client.first_inspection_plan('10000000000000002')
        self.assertEqual(json.loads(transport.call_args.args[1]), {'workOrderId': 10000000000000002, 'checkType': 3})

    def test_first_production_and_periodic_lookup_have_explicit_types_and_same_scope_bounds(self):
        transport = Mock()
        client = ScopedInspectionReadClient(transport)
        for check_type in (3, 4, 5):
            client.list_inspections('10000000000000001', check_type=check_type, page=2, size=25)
            self.assertEqual(json.loads(transport.call_args.args[1]),
                {'workOrderIds': [10000000000000001], 'checkType': check_type, 'page': 2, 'size': 25})
            client.inspection_plan('10000000000000001', check_type=check_type)
            self.assertEqual(json.loads(transport.call_args.args[1]),
                {'workOrderId': 10000000000000001, 'checkType': check_type})
        client.list_periodic_inspections('10000000000000001')
        self.assertEqual(json.loads(transport.call_args.args[1])['checkType'], 5)
        client.periodic_inspection_plan('10000000000000001')
        self.assertEqual(json.loads(transport.call_args.args[1])['checkType'], 5)

    def test_inspection_lookup_rejects_guessed_or_coerced_types_before_transport(self):
        transport = Mock()
        client = ScopedInspectionReadClient(transport)
        for value in (True, False, 3.0, '3', 'first', 'process', '巡检', None, 0, 2, 6):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    client.list_inspections('1', check_type=value)
                with self.assertRaises(ValueError):
                    client.inspection_plan('1', check_type=value)
        for kwargs in ({'page': 3}, {'page': True}, {'size': 26}, {'size': 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                client.list_periodic_inspections('1', **kwargs)
        transport.assert_not_called()

    def test_result_and_finish_are_separate_reviewable_stages(self):
        stages = result_and_finish_plan('10000000000000001', [{'checkItemId': '10000000000000002',
            'groupName': '尺寸', 'seq': 1, 'min': Decimal('9.500'), 'max': Decimal('10.500'), 'attachmentIds': ['10000000000000003']}], verdict='pass')
        self.assertEqual(len(stages), 2)
        self.assertTrue(stages[0].endpoint.endswith('_update_task_check_item'))
        self.assertTrue(stages[1].endpoint.endswith('_finish'))
        self.assertIn('9.500', stages[0].json_body)
        self.assertEqual(json.loads(stages[1].json_body), {'id': 10000000000000001, 'status': 1})
        self.assertFalse(hasattr(stages[0], 'send'))

    def test_no_specification_or_credential_or_weak_rule_override(self):
        for extra in ['skipWeakControlRule', 'access_token', 'qcConfigId', 'status']:
            with self.assertRaises(ValueError):
                result_and_finish_plan('1', [{'checkItemId': '2', 'groupName': 'A', 'seq': 1, extra: 'x'}], verdict='pass')
        with self.assertRaises(ValueError):
            result_and_finish_plan('1', [{'checkItemId': '2', 'groupName': 'A', 'seq': 1, 'min': 0.1}], verdict='pass')
        with self.assertRaises(ValueError):
            encode_payload({'quantity': float('nan')})

    def test_qc_verdicts_are_not_collapsed(self):
        for verdict, status in [('pass', 1), ('concession', 2), ('pending', 3), ('fail', 4)]:
            plan = result_and_finish_plan('1', [{'checkItemId': '2', 'groupName': 'A', 'seq': 1, 'result': '1'}], verdict=verdict)
            self.assertEqual(json.loads(plan[1].json_body)['status'], status)

    def test_no_implicit_pass_conclusion(self):
        with self.assertRaises(TypeError):
            result_and_finish_plan('1', [{'checkItemId': '2', 'groupName': 'A', 'seq': 1, 'result': '1'}])

    def test_duplicate_sample_rejected_even_when_ids_use_different_representations(self):
        first = {'checkItemId': '2', 'groupName': 'SYNTHETIC', 'seq': 1, 'result': '1.0'}
        duplicate = dict(first, checkItemId=2, result='2.0')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            result_and_finish_plan('1', [first, duplicate], verdict='pass')

    def test_distinct_sample_sequences_are_not_collapsed(self):
        first = {'checkItemId': '2', 'groupName': 'SYNTHETIC', 'seq': 1, 'result': '1.0'}
        second = dict(first, seq=2, result='2.0')
        plan = result_and_finish_plan('1', [first, second], verdict='fail')
        records = json.loads(plan[0].json_body)['checkItems']
        self.assertEqual([item['seq'] for item in records], [1, 2])
        self.assertEqual([item['result'] for item in records], ['1.0', '2.0'])
