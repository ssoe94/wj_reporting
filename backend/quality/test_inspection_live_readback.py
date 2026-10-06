"""Fabricated MES detail shapes; no credential, network, ORM or fixture normalizer."""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_live_readback import decode_live_detail


NOW = datetime(2026, 10, 4, 10, 0, tzinfo=timezone.utc)


class LiveReadbackTests(unittest.TestCase):
    def setUp(self):
        self.binding = SimpleNamespace(tenant='SYNTHETIC-TENANT', qc_id='91000000000000001',
            work_order_id='91000000000000002', test_label='SYNTHETIC-PERMANENT-TEST-LABEL',
            contract={'production_task_id': '91000000000000003', 'equipment_id': '91000000000000004',
                'snapshot_id': '91000000000000005', 'actor_id': '91000000000000006',
                'items': [{'local_item_id': 'dimension', 'config_row_id': '91000000000000007',
                    'write_item_id': '91000000000000008', 'group': 'SYNTHETIC-GROUP', 'seq': 1}]})
        # Deliberately invented code values, not assertions about provider enums.
        self.contract = {'reference': 'SYNTHETIC-DETAIL-REVIEW',
            'lifecycle_codes': {'open': [701, 702], 'completed': [703], 'approval_pending': [704],
                'cancelled': [705], 'rejected': [706]}, 'verdict_codes': {'pass': 801, 'fail': 802},
            'executor_path': ['executor', 'id'], 'label_path': ['permanentLabel'], 'check_type': 3,
            'source_checks': [{'path': ['qcConfig', 'attachmentRequired'], 'equals': False},
                {'path': ['qcConfig', 'quantityRequired'], 'equals': False},
                {'path': ['sourceMarker'], 'equals': None}]}
        self.raw = {'code': 200, 'needCheck': 0, 'data': {
            'id': 91000000000000001, 'workOrder': {'id': 91000000000000002},
            'produceTask': {'id': 91000000000000003}, 'equipment': {'id': 91000000000000004},
            'executor': {'id': 91000000000000006}, 'permanentLabel': self.binding.test_label,
            'checkType': {'code': 3}, 'status': {'code': 701}, 'inspectionResult': None,
            'sourceMarker': None, 'endTime': None,
            'qcConfig': {'snapshotId': 91000000000000005, 'checkType': 3,
                'recordSample': {'code': 2}, 'recordSummaryCount': {'code': 2},
                'materialBatchRecordType': {'code': 1}, 'sampleProcessMethod': {'code': 1},
                'attachmentRequired': False, 'quantityRequired': False,
                'qcConfigCheckItemList': [{'groupName': 'SYNTHETIC-GROUP',
                    'checkItemAppDetailVOS': [{'id': 91000000000000007}]}]},
            'checkItems': []}}

    def decode(self):
        return decode_live_detail(self.raw, binding=self.binding, detail_contract=self.contract, observed_at=NOW)

    def record(self, *, seq=1, value='010.5000'):
        self.raw['data']['checkItems'] = [{'groupName': 'SYNTHETIC-GROUP', 'qcTaskCheckItems': [{
            'qcConfigCheckItemId': 91000000000000007, 'seq': seq, 'result': value}]}]

    def unknown(self):
        with self.assertRaises(MesOutcomeUnknown) as caught:
            self.decode()
        self.assertEqual(caught.exception.args, ())
        self.assertEqual(str(caught.exception), '')

    def unavailable(self):
        with self.assertRaises(MesContractUnavailable) as caught:
            self.decode()
        self.assertEqual(caught.exception.args, ())
        self.assertEqual(str(caught.exception), '')

    def test_open_initial_read_allows_empty_records_and_exact_64_bit_identity(self):
        observed = self.decode()
        self.assertEqual(observed, {'identity': {'tenant': 'SYNTHETIC-TENANT',
            'qc_id': '91000000000000001', 'work_order_id': '91000000000000002',
            'production_task_id': '91000000000000003', 'equipment_id': '91000000000000004',
            'snapshot_id': '91000000000000005'}, 'observed_at': NOW,
            'state': 'open', 'inspectionResult': None, 'test_label': self.binding.test_label,
            'records': [], 'completed_at': None})

    def test_reviewed_completed_and_approval_pending_verdicts(self):
        self.record()
        self.raw['data']['endTime'] = int(NOW.timestamp()) * 1000
        for state, code in [('completed', 703), ('approval_pending', 704)]:
            for verdict, result in [('pass', 801), ('fail', 802)]:
                with self.subTest(state=state, verdict=verdict):
                    self.raw['data']['status'] = code
                    self.raw['data']['inspectionResult'] = {'code': result, 'message': 'not used'}
                    observed = self.decode()
                    self.assertEqual(observed['state'], state)
                    self.assertEqual(observed['inspectionResult'], verdict)

    def test_cancelled_rejected_and_second_explicit_open_code(self):
        for state, code in [('cancelled', 705), ('rejected', 706), ('open', 702)]:
            self.raw['data']['status'] = code
            self.assertEqual(self.decode()['state'], state)

    def test_result_is_preserved_without_numeric_or_whitespace_normalization(self):
        for value in ['010.5000', '  SYNTHETIC text\n', '', '选项 A']:
            self.record(value=value)
            self.assertEqual(self.decode()['records'], [{'config_row_id': '91000000000000007',
                'group': 'SYNTHETIC-GROUP', 'seq': 1, 'value': value}])

    def test_identity_mismatch_or_missing_relation_is_unknown(self):
        for path in [('id',), ('workOrder', 'id'), ('produceTask', 'id'),
                     ('equipment', 'id'), ('qcConfig', 'snapshotId')]:
            original = deepcopy(self.raw)
            target = self.raw['data']
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = 91000000000000199
            self.unknown()
            self.raw = original
        del self.raw['data']['produceTask']
        self.unknown()

    def test_float_bool_zero_and_noncanonical_identity_are_not_ids(self):
        for value in [True, 0, 91000000000000001.0, '091000000000000001', '+91000000000000001', None]:
            self.raw['data']['id'] = value
            self.unknown()

    def test_changed_executor_is_not_saved_authority(self):
        self.raw['data']['executor']['id'] += 1
        self.raw['data']['getAble'] = 1
        self.unknown()

    def test_executor_missing_or_wrong_shape_does_not_use_query_subject(self):
        del self.raw['data']['executor']
        self.raw['data']['receiveUserId'] = int(self.binding.contract['actor_id'])
        self.unknown()

    def test_label_missing_null_changed_or_numeric_never_echoes_binding(self):
        for value in [None, '', 'SYNTHETIC-OTHER-LABEL', 123]:
            self.raw['data']['permanentLabel'] = value
            self.unknown()
        del self.raw['data']['permanentLabel']
        self.unknown()

    def test_both_check_types_must_equal_reviewed_contract(self):
        for location in [self.raw['data'], self.raw['data']['qcConfig']]:
            before = location['checkType']
            for value in [4, True, '3', {'code': 5}, {'code': True}, None]:
                location['checkType'] = value
                self.unknown()
            location['checkType'] = before

    def test_all_explicit_supported_check_types_and_batch_modes(self):
        for check_type in (3, 4, 5):
            self.contract['check_type'] = check_type
            self.raw['data']['checkType'] = check_type
            self.raw['data']['qcConfig']['checkType'] = {'code': check_type}
            for mode in (1, 2):
                self.raw['data']['qcConfig']['materialBatchRecordType'] = mode
                self.assertEqual(self.decode()['state'], 'open')

    def test_quantity_sample_scrap_or_unknown_modes_fail_closed(self):
        config = self.raw['data']['qcConfig']
        for field, values in {'recordSample': [1, True, None, '2'],
                'recordSummaryCount': [1, 3, {'code': '2'}],
                'materialBatchRecordType': [0, 3, False], 'sampleProcessMethod': [2, 0, True]}.items():
            original = config[field]
            for value in values:
                config[field] = value
                self.unknown()
            del config[field]
            self.unknown()
            config[field] = original

    def test_unknown_and_bool_lifecycle_or_verdict_are_not_guessed(self):
        for value in [1, True, '701', {'code': '701'}, {'code': None}]:
            self.raw['data']['status'] = value
            self.unknown()
        self.raw['data']['status'] = 701
        for value in [1, True, '801', {'code': True}, {'code': 0}]:
            self.raw['data']['inspectionResult'] = value
            self.unknown()

    def test_missing_verdict_is_distinct_from_null_and_terminal_null_is_unknown(self):
        del self.raw['data']['inspectionResult']
        self.unknown()
        self.raw['data']['inspectionResult'] = None
        for code in (703, 704):
            self.raw['data']['status'] = code
            self.unknown()

    def test_source_checks_distinguish_missing_null_bool_int_and_exact_text(self):
        del self.raw['data']['sourceMarker']
        self.unknown()
        self.raw['data']['sourceMarker'] = None
        self.raw['data']['qcConfig']['attachmentRequired'] = 0
        self.unknown()
        self.raw['data']['qcConfig']['attachmentRequired'] = False
        self.contract['source_checks'][-1]['equals'] = 'SYNTHETIC marker '
        self.raw['data']['sourceMarker'] = 'SYNTHETIC marker'
        self.unknown()
        self.raw['data']['sourceMarker'] += ' '
        self.assertEqual(self.decode()['state'], 'open')

    def test_source_checks_do_not_coerce_numeric_types(self):
        self.contract['source_checks'][-1]['equals'] = 1
        for value in [True, 1.0, Decimal('1'), '1']:
            self.raw['data']['sourceMarker'] = value
            self.unknown()
        self.raw['data']['sourceMarker'] = 1
        self.assertEqual(self.decode()['state'], 'open')

    def test_config_missing_extra_duplicate_or_moved_item_is_unknown(self):
        config = self.raw['data']['qcConfig']
        groups = deepcopy(config['qcConfigCheckItemList'])
        for rows in [[], [deepcopy(groups[0]), deepcopy(groups[0])]]:
            config['qcConfigCheckItemList'] = rows
            self.unknown()
        config['qcConfigCheckItemList'] = deepcopy(groups)
        rows = config['qcConfigCheckItemList'][0]['checkItemAppDetailVOS']
        rows.append(deepcopy(rows[0]))
        self.unknown()
        rows[-1]['id'] += 1
        self.unknown()
        config['qcConfigCheckItemList'] = deepcopy(groups)
        config['qcConfigCheckItemList'][0]['groupName'] = 'SYNTHETIC-OTHER'
        self.unknown()

    def test_duplicate_extra_unknown_group_or_sample_records_are_unknown(self):
        self.record()
        original = deepcopy(self.raw['data']['checkItems'])
        self.raw['data']['checkItems'][0]['qcTaskCheckItems'].append(deepcopy(original[0]['qcTaskCheckItems'][0]))
        self.unknown()
        for field, value in [('qcConfigCheckItemId', 91000000000000999), ('seq', 2)]:
            self.raw['data']['checkItems'] = deepcopy(original)
            self.raw['data']['checkItems'][0]['qcTaskCheckItems'][0][field] = value
            self.unknown()
        self.raw['data']['checkItems'] = deepcopy(original)
        self.raw['data']['checkItems'][0]['groupName'] = 'SYNTHETIC-OTHER'
        self.unknown()
        self.raw['data']['checkItems'] = original + deepcopy(original)
        self.unknown()

    def test_result_cannot_be_inferred_from_number_option_or_missing_field(self):
        for value in [None, 10, 10.5, True, ['A'], {'text': 'A'}, 'x' * 501]:
            self.record(value=value)
            self.unknown()
        self.record()
        row = self.raw['data']['checkItems'][0]['qcTaskCheckItems'][0]
        del row['result']
        row['option'] = ['SYNTHETIC-OPTION']
        row['min'] = '10.5'
        self.unknown()

    def test_seq_requires_positive_bounded_exact_integer(self):
        for value in [0, -1, True, '1', 1.0, 10001]:
            self.record(seq=value)
            self.unknown()

    def test_partial_approved_samples_are_returned_without_claiming_saved(self):
        second = deepcopy(self.binding.contract['items'][0])
        second.update(local_item_id='dimension-second', seq=2)
        self.binding.contract['items'].append(second)
        self.record()
        observed = self.decode()
        self.assertEqual(len(observed['records']), 1)
        self.assertNotIn('saved', observed)

    def test_malformed_envelope_or_unresolved_weak_control_is_unknown(self):
        original = deepcopy(self.raw)
        for response in [None, [], {'code': True, 'data': original['data']},
                {'code': '200', 'data': original['data']}, {'code': 500, 'data': original['data']},
                {'code': 200, 'data': None}]:
            self.raw = response
            self.unknown()
        for confirmation in [True, '0', 1]:
            self.raw = {**original, 'needCheck': confirmation}
            self.unknown()
        self.raw = deepcopy(original)
        del self.raw['needCheck']
        self.assertEqual(self.decode()['state'], 'open')
        self.raw['needCheck'] = None
        self.assertEqual(self.decode()['state'], 'open')

    def test_completion_time_requires_explicit_null_or_exact_epoch_milliseconds(self):
        for value in [True, 1.5, '123', -1, 253402300800000, int(NOW.timestamp()) * 1000 + 1]:
            self.raw['data']['endTime'] = value
            self.unknown()
        del self.raw['data']['endTime']
        self.unknown()

    def test_terminal_completion_time_is_required_and_utc_without_float_rounding(self):
        for state in (703, 704):
            self.raw['data']['status'] = state
            self.raw['data']['inspectionResult'] = 801
            self.raw['data']['endTime'] = None
            self.unknown()
            self.raw['data']['endTime'] = int(NOW.timestamp()) * 1000 - 123
            completed = self.decode()['completed_at']
            self.assertEqual(completed.isoformat(), '2026-10-04T09:59:59.877000+00:00')
            self.assertIs(completed.tzinfo, timezone.utc)

    def test_review_reference_check_type_and_contract_keys_are_required(self):
        original = deepcopy(self.contract)
        for field, value in [('reference', ''), ('reference', None), ('check_type', True), ('check_type', 2)]:
            self.contract = {**original, field: value}
            self.unavailable()
        self.contract = {**original, 'unexpected_default': 1}
        self.unavailable()
        self.contract = deepcopy(original)
        del self.contract['reference']
        self.unavailable()

    def test_lifecycle_and_verdict_maps_reject_duplicates_bool_and_wrong_types(self):
        original = deepcopy(self.contract)
        for codes in [[True], [701, 701], ['701'], 701]:
            self.contract = deepcopy(original)
            self.contract['lifecycle_codes']['open'] = codes
            self.unavailable()
        self.contract = deepcopy(original)
        self.contract['lifecycle_codes']['completed'] = [701]
        self.unavailable()
        self.contract = deepcopy(original)
        del self.contract['lifecycle_codes']['cancelled']
        self.unavailable()
        for codes in [{'pass': True, 'fail': 802}, {'pass': 801, 'fail': 801}, {'pass': '801', 'fail': 802}]:
            self.contract = {**deepcopy(original), 'verdict_codes': codes}
            self.unavailable()

    def test_unsupported_lifecycle_may_be_explicitly_empty_without_fake_code(self):
        self.contract['lifecycle_codes']['cancelled'] = []
        self.assertEqual(self.decode()['state'], 'open')
        self.raw['data']['status'] = 705
        self.unknown()

    def test_source_paths_and_scalars_require_reviewed_nonoverlapping_shapes(self):
        original = deepcopy(self.contract)
        for path in [[], 'sourceMarker', [0], [''], ['x'] * 9]:
            self.contract = deepcopy(original)
            self.contract['source_checks'][-1]['path'] = path
            self.unavailable()
        for expected in [{}, [], float('nan'), float('inf')]:
            self.contract = deepcopy(original)
            self.contract['source_checks'][-1]['equals'] = expected
            self.unavailable()
        for check in [{'path': ['qcConfig'], 'equals': None}, deepcopy(original['source_checks'][0])]:
            self.contract = deepcopy(original)
            self.contract['source_checks'].append(check)
            self.unavailable()

    def test_executor_label_paths_cannot_overlap_and_no_default_is_supplied(self):
        self.contract['executor_path'] = []
        self.unavailable()
        self.contract['executor_path'] = ['permanentLabel', 'id']
        self.unavailable()

    def test_malformed_or_duplicate_reviewed_binding_is_contract_unavailable(self):
        self.binding.contract['items'].append(deepcopy(self.binding.contract['items'][0]))
        self.unavailable()
        self.binding.contract['items'].pop()
        self.binding.contract['actor_id'] = True
        self.unavailable()

    def test_aware_observation_is_required_without_source_timestamp_inference(self):
        for timestamp in [None, NOW.isoformat(), NOW.replace(tzinfo=None)]:
            with self.assertRaises(MesContractUnavailable):
                decode_live_detail(self.raw, binding=self.binding, detail_contract=self.contract, observed_at=timestamp)
        self.raw['data']['updatedAt'] = 'SYNTHETIC-NOT-A-TIMESTAMP'
        self.assertEqual(self.decode()['observed_at'], NOW)

    def test_inputs_are_not_modified_and_unrecognized_private_fields_are_not_returned(self):
        self.raw['data']['privateField'] = 'SYNTHETIC-NONOUTPUT-VALUE'
        self.record()
        before = deepcopy((self.raw, self.binding, self.contract))
        observed = self.decode()
        self.assertEqual((self.raw, self.binding, self.contract), before)
        self.assertNotIn('SYNTHETIC-NONOUTPUT-VALUE', repr(observed))

    def test_no_fixture_normalizer_or_runtime_transport_is_used(self):
        with patch('quality.inspection_blacklake_snapshot.normalize_blacklake_detail',
                   side_effect=AssertionError('Fixture normalizer forbidden.')):
            self.assertEqual(self.decode()['state'], 'open')


if __name__ == '__main__':
    unittest.main()
