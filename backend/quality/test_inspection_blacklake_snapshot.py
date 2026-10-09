"""Stdlib-only contract tests: fabricated fixture and synthetic mutations only.

Run with scripts/check-inspection-requests.py or module discovery.
No Django setup, environment file, credentials, database or network is involved.
"""
from copy import deepcopy
from datetime import datetime
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import sys
import unittest


from .inspection_read_snapshot import ReadScope
from . import inspection_blacklake_snapshot as decoder
FIXTURE_PATH = Path(__file__).parent / 'fixtures/blacklake_detail_synthetic.json'
FIXTURE_SHA = 'd7a015704c126bbc3c8e4781fee47de0c4085f762a6f21ebe111c02bc58b71f0'
FIXTURE_BYTES = FIXTURE_PATH.read_bytes()
if hashlib.sha256(FIXTURE_BYTES).hexdigest() != FIXTURE_SHA:
    raise ValueError('The synthetic fixture checksum differs.')
FIXTURE = json.loads(FIXTURE_BYTES, parse_float=Decimal)
OBSERVED_AT = datetime.fromisoformat(FIXTURE['metadata']['observed_at_utc'])
SCOPE = ReadScope('SYNTHETIC_NAMESPACE', '91000000000000059', '91000000000000001')


class BlacklakeSnapshotTests(unittest.TestCase):
    def decode(self, response=None, **kwargs):
        options = dict(scope=SCOPE, observed_at=OBSERVED_AT,
                       evidence_reference=f'{FIXTURE_PATH.name}#sha256:{FIXTURE_SHA}',
                       evidence_kind='synthetic_contract_fixture')
        options.update(kwargs)
        return decoder.normalize_blacklake_detail(
            deepcopy(FIXTURE['response']) if response is None else response, **options)

    def source(self):
        return deepcopy(FIXTURE['response'])

    def config_rows(self, response):
        return response['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS']

    def records(self, response):
        return response['data']['checkItems'][0]['qcTaskCheckItems']

    def test_fabricated_fixture_identity_cardinality_and_independent_enums(self):
        result = self.decode()
        self.assertEqual(result['qc_id'], SCOPE.qc_id)
        self.assertEqual(result['work_order_id'], SCOPE.work_order_id)
        self.assertEqual(result['production_task_id'], '91000000000000058')
        self.assertEqual(result['equipment_id'], '91000000000000004')
        self.assertEqual(result['snapshot_id'], '91000000000000005')
        self.assertEqual((len(result['items']), sum(len(i['records']) for i in result['items'])), (16, 16))
        self.assertEqual(result['kind'], 'first')
        self.assertEqual(result['lifecycle'], {'code': 2, 'message': 'SYNTHETIC_ENDED'})
        self.assertEqual(result['judgement'], {'code': 1, 'message': 'SYNTHETIC_PASS'})
        self.assertEqual(result['production_status'], {'code': None, 'message': None})
        self.assertEqual(result['warnings'], ['plan_name_type_mismatch'])

    def test_read_evidence_never_becomes_write_or_current_state_authority(self):
        result = self.decode()
        self.assertTrue(result['read_only'])
        self.assertFalse(result['current_state_verified'])
        self.assertFalse(result['physical_operation_verified'])
        self.assertEqual(result['receipt_readiness'], 'not_verified')
        self.assertEqual(result['evidence_kind'], 'synthetic_contract_fixture')
        default = decoder.normalize_blacklake_detail(deepcopy(FIXTURE['response']), scope=SCOPE, observed_at=OBSERVED_AT, evidence_reference='SYNTHETIC_DEFAULT_TEST')
        self.assertEqual(default['evidence_kind'], 'synthetic_contract_fixture')
        self.assertFalse(default['current_state_verified'])
        self.assertEqual(result['source_metadata']['tenant_namespace_source'], 'caller_supplied_not_response_verified')
        for item in result['items']:
            self.assertFalse(item['write_mapping_verified'])
            self.assertIsNone(item['write_check_item_id'])
            for record in item['records']:
                self.assertFalse(record['write_mapping_verified'])
                self.assertIsNone(record['write_check_item_id'])

    def test_ids_and_serial_number_are_separate_from_sample_sequence(self):
        item = self.decode()['items'][4]
        self.assertEqual(item['source_item_id'], '91000000000000017')
        self.assertEqual(item['source']['master_check_item_id'], '91000000000000018')
        self.assertEqual(item['source']['config_version_id'], '91000000000000007')
        self.assertEqual(item['source']['serial_no'], 5)
        self.assertEqual(item['records'][0]['record_id'], '91000000000000045')
        self.assertEqual(item['seq'], 1)

    def test_decimal_scale_is_preserved_and_renderer_values_are_exact(self):
        with localcontext() as ctx:
            ctx.prec = 3
            item = self.decode()['items'][0]
        self.assertEqual(item['source']['minimum'], '11.1000000000')
        self.assertEqual(item['source']['maximum'], '11.9000000000')
        self.assertEqual(item['minimum'], '11.1')
        self.assertEqual(item['maximum'], '11.9')
        self.assertEqual(item['records'][0]['task_check_count'], '8.0000000000')
        response = self.source()
        self.config_rows(response)[0]['min'] = Decimal('11.123456789012345678')
        result = self.decode(response)['items'][0]
        self.assertEqual(result['minimum'], '11.123456789012345678')
        self.assertEqual(result['source']['minimum'], '11.123456789012345678')

    def test_weight_null_result_is_not_replaced_by_range_or_completion(self):
        item = self.decode()['items'][4]
        self.assertEqual(item['source']['value_type']['code'], 2)
        self.assertIsNone(item['recorded_value'])
        record = item['records'][0]
        self.assertIsNone(record['result'])
        self.assertEqual(record['minimum'], '55.0000000000')
        self.assertIsNone(record['maximum'])
        self.assertEqual(record['single_judgment'], 1)
        self.assertNotIn('completed', record)

    def test_deformation_comparator_and_base_do_not_invent_minimum_or_maximum(self):
        item = self.decode()['items'][5]
        self.assertEqual(item['source']['logic'], {'code': 5, 'message': 'SYNTHETIC <='})
        self.assertEqual(item['source']['base'], '7.0000000000')
        self.assertEqual(item['source']['scale'], 1)
        self.assertIsNone(item['minimum'])
        self.assertIsNone(item['maximum'])

    def test_optional_choice_rule_does_not_override_task_judgement(self):
        item = self.decode()['items'][6]
        self.assertFalse(item['required'])
        self.assertEqual(item['source']['options'], ['SYNTHETIC_OK', 'SYNTHETIC_NOT_OK'])
        self.assertEqual(item['records'][0]['option'], ['SYNTHETIC_OK'])
        response = self.source()
        self.records(response)[6]['singleJudgment'] = 4
        result = self.decode(response)
        self.assertEqual(result['judgement']['code'], 1)
        self.assertEqual(result['items'][6]['records'][0]['single_judgment'], 4)

    def test_record_order_and_config_order_never_determine_join(self):
        response = self.source()
        self.records(response).reverse()
        self.config_rows(response).reverse()
        by_id = {item['source_item_id']: item for item in self.decode(response)['items']}
        self.assertEqual(by_id['91000000000000006']['recorded_value'], '11.45')
        self.assertEqual(by_id['91000000000000011']['recorded_value'], '21.54')

    def test_multiple_samples_preserved_and_not_flattened(self):
        response = self.source()
        sample = deepcopy(self.records(response)[0])
        sample.update(id='91000000000999999', seq=2, result='11.60')
        self.records(response).insert(0, sample)
        item = self.decode(response)['items'][0]
        self.assertEqual([record['seq'] for record in item['records']], [1, 2])
        self.assertEqual([record['result'] for record in item['records']], ['11.45', '11.60'])
        self.assertIsNone(item['recorded_value'])
        self.assertIsNone(item['seq'])

    def test_config_without_record_is_retained_as_unknown(self):
        response = self.source()
        self.records(response).pop(0)
        item = self.decode(response)['items'][0]
        self.assertEqual(item['records'], [])
        self.assertIsNone(item['recorded_value'])
        self.assertIsNone(item['seq'])

    def test_epoch_ms_are_aware_and_qc_config_observed_times_are_distinct(self):
        result = self.decode()
        meta = result['source_metadata']
        self.assertEqual(meta['qc_timestamps']['endTime']['epoch_ms'], 978652800000)
        self.assertEqual(meta['qc_timestamps']['endTime']['iso_utc'], '2001-01-05T00:00:00+00:00')
        self.assertEqual(meta['config_timestamps']['updatedAt']['epoch_ms'], 978739200000)
        self.assertNotEqual(result['source_updated_at'], meta['config_timestamps']['updatedAt']['iso_utc'])
        self.assertEqual(result['observed_at'], OBSERVED_AT.isoformat())
        self.assertIn('not_immutable', meta['config_timestamp_semantics'])
        response = self.source()
        response['data']['endTime'] = 978652800123
        self.assertEqual(self.decode(response)['source_metadata']['qc_timestamps']['endTime']['iso_utc'],
                         '2001-01-05T00:00:00.123000+00:00')

    def test_needcheck_absent_null_and_integer_zero_are_allowed(self):
        for value in ('absent', None, 0):
            with self.subTest(value=value):
                response = self.source()
                if value == 'absent':
                    response.pop('needCheck')
                else:
                    response['needCheck'] = value
                self.decode(response)

    def test_needcheck_ambiguous_boolean_and_positive_values_are_rejected(self):
        for value in (False, True, 1, -1, '0', {}, []):
            with self.subTest(value=value):
                response = self.source()
                response['needCheck'] = value
                with self.assertRaises(ValueError):
                    self.decode(response)

    def test_snapshot_identity_is_mandatory_and_type_conflicts_are_warned(self):
        response = self.source()
        response['data']['qcConfig'].pop('snapshotId')
        with self.assertRaises(ValueError):
            self.decode(response)
        response = self.source()
        response['data']['qcConfig']['checkType'] = {'code': 5, 'message': 'SYNTHETIC_PERIODIC'}
        result = self.decode(response)
        self.assertEqual(result['kind'], 'unknown')
        self.assertIn('qc_snapshot_type_conflict', result['warnings'])
        response['data']['qcConfig']['checkType'] = None
        self.assertIn('snapshot_type_unknown', self.decode(response)['warnings'])

    def test_cross_scope_unknown_tenant_and_naive_observation_are_rejected(self):
        for scope in (ReadScope('', SCOPE.work_order_id, SCOPE.qc_id),
                      ReadScope(SCOPE.tenant, '123', SCOPE.qc_id),
                      ReadScope(SCOPE.tenant, SCOPE.work_order_id, '123')):
            with self.subTest(scope=scope), self.assertRaises(ValueError):
                self.decode(scope=scope)
        with self.assertRaises(ValueError):
            self.decode(observed_at=datetime(2001, 2, 1))
        with self.assertRaises(ValueError):
            self.decode(evidence_kind='live_verified')

    def test_invalid_ids_never_round_or_alias(self):
        for value in (True, 1.0, '1e3', '01', '0', '-1', '9223372036854775808', None):
            for owner, key in (('root', 'id'), ('config', 'checkItemId'), ('record', 'id')):
                with self.subTest(value=value, owner=owner):
                    response = self.source()
                    target = {'root': response['data'], 'config': self.config_rows(response)[0],
                              'record': self.records(response)[0]}[owner]
                    target[key] = value
                    with self.assertRaises(ValueError):
                        self.decode(response)

    def test_duplicate_config_or_record_groups_rejected(self):
        for part, key in (('config', 'qcConfigCheckItemList'), ('data', 'checkItems')):
            with self.subTest(part=part):
                response = self.source()
                target = response['data']['qcConfig'] if part == 'config' else response['data']
                target[key].append(deepcopy(target[key][0]))
                with self.assertRaises(ValueError):
                    self.decode(response)

    def test_duplicate_ids_and_duplicate_sample_relation_rejected(self):
        for mode in ('config_id', 'record_id', 'sample_relation'):
            with self.subTest(mode=mode):
                response = self.source()
                if mode == 'config_id':
                    self.config_rows(response)[1]['id'] = self.config_rows(response)[0]['id']
                elif mode == 'record_id':
                    self.records(response)[1]['id'] = self.records(response)[0]['id']
                else:
                    sample = deepcopy(self.records(response)[0])
                    sample['id'] = '91000000000999999'
                    self.records(response).append(sample)
                with self.assertRaises(ValueError):
                    self.decode(response)

    def test_unknown_record_relation_and_conflicting_inner_group_rejected(self):
        for mode in ('unknown_config', 'unknown_group', 'inner_group'):
            with self.subTest(mode=mode):
                response = self.source()
                if mode == 'unknown_config':
                    self.records(response)[0]['qcConfigCheckItemId'] = '9999'
                elif mode == 'unknown_group':
                    response['data']['checkItems'][0]['groupName'] = 'SYNTHETIC_DIFFERENT_GROUP'
                else:
                    self.config_rows(response)[0]['groupName'] = 'SYNTHETIC_DIFFERENT_GROUP'
                with self.assertRaises(ValueError):
                    self.decode(response)

    def test_invalid_decimal_float_and_precision_rejected(self):
        for value in (False, 11.1, 'NaN', 'Infinity', '1e2', '1.1234567890123456789', '1000000000000001'):
            with self.subTest(value=value):
                response = self.source()
                self.config_rows(response)[0]['min'] = value
                with self.assertRaises(ValueError):
                    self.decode(response)
        with localcontext() as ctx:
            ctx.prec = 3
            response = self.source()
            self.config_rows(response)[0]['min'] = '1000000000000001'
            with self.assertRaises(ValueError):
                self.decode(response)

    def test_invalid_source_types_and_bounds_rejected(self):
        cases = [('seq', 0), ('seq', True), ('seq', 10001), ('singleJudgment', True), ('result', 'x' * 501)]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                response = self.source()
                self.records(response)[0][key] = value
                with self.assertRaises(ValueError):
                    self.decode(response)
        for key, value in (('endTime', True), ('endTime', 978739200.0), ('status', {'code': True})):
            response = self.source()
            response['data'][key] = value
            with self.assertRaises(ValueError):
                self.decode(response)

    def test_collection_bounds_rejected_before_unbounded_processing(self):
        response = self.source()
        response['data']['checkItems'] *= 21
        with self.assertRaises(ValueError):
            self.decode(response)
        response = self.source()
        self.records(response).extend(deepcopy(self.records(response)) * 32)
        with self.assertRaises(ValueError):
            self.decode(response)
        response = self.source()
        rows = self.config_rows(response)
        template = deepcopy(rows[0])
        for count in range(101):
            extra = deepcopy(template)
            extra['id'] = str(100000 + count)
            rows.append(extra)
        with self.assertRaises(ValueError):
            self.decode(response)

    def test_allowlist_drops_unrelated_payload_and_does_not_mutate_input(self):
        response = self.source()
        response['data']['unrelated_secret'] = 'DO-NOT-COPY'
        self.records(response)[0]['unrelated_secret'] = 'DO-NOT-COPY'
        before = deepcopy(response)
        result = self.decode(response)
        self.assertEqual(response, before)
        serialized = json.dumps(result)
        self.assertNotIn('DO-NOT-COPY', serialized)
        self.assertNotIn('unrelated_secret', serialized)
        # The envelope remains JSON serializable, without float or Decimal IDs.
        self.assertIsInstance(json.loads(serialized)['qc_id'], str)


if __name__ == '__main__':
    unittest.main(verbosity=2)
