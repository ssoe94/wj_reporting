"""Synthetic full-detail decoder checks; no MES calls or real QC data."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import json

from django.test import SimpleTestCase

from .inspection_full_snapshot import FullSnapshotError, normalize_observation
from .inspection_full_snapshot_readback import (
    CONFIG_FIELDS, EMPTY_MATERIALS, ITEM_FIELDS, NULL_RELATIONS, DetailPin,
    FullDetailReview, decode_full_detail, parse_full_detail_json,
)


class FullDetailDecoderTests(SimpleTestCase):
    def setUp(self):
        self.at = datetime.now(timezone.utc)
        begin = int((self.at - timedelta(minutes=2)).timestamp() * 1000)
        self.binding = SimpleNamespace(tenant='SYNTHETIC tenant', qc_id='31', contract={
            'snapshot_id': '32', 'actor_id': '101', 'items': [
                {'local_item_id': label, 'config_row_id': str(row_id),
                 'write_item_id': str(master), 'group': 'SYNTHETIC group', 'seq': 1}
                for label, row_id, master in [('A', 401, 501), ('B', 402, 502)]],
        })
        rows = []
        for index, row_id, master in [(0, 401, 501), (1, 402, 502)]:
            rows.append({
                'id': row_id, 'checkItemId': master, 'checkItemCode': str(index + 1),
                'groupName': None, 'serialNo': index + 1, 'executeItemType': {'code': 1},
                'checkValueType': {'code': 1}, 'logic': {'code': 1}, 'base': None,
                'min': 9.0 + index * 10, 'max': 11.0 + index * 10,
                'defaultValue': None, 'defaultMin': None, 'defaultMax': None,
                'unit': {'id': 601, 'name': 'mm'}, 'recordCheckItemType': {'code': 1},
                'requireReportCount': 1, 'scale': 2, 'qcConfigVersionId': 701,
                'totalReportCount': 1, 'filledReportCount': 0, 'taskCheckCount': 0,
            })
        config = {
            'snapshotId': 32, 'code': 'SYNTHETIC plan', 'remark': 'SYNTHETIC values',
            'state': {'code': 1}, 'checkType': {'code': 6},
            'checkEntityType': {'code': 1}, 'checkEntityUnitCount': 1,
            'reportPageType': {'code': 1}, 'sampleProcessMethod': {'code': 1},
            'qcRange': None, 'recordSample': False, 'recordSummaryCount': False,
            'materialBatchRecordType': {'code': 1},
            'inspectionResultOptions': [{'code': 1}, {'code': 4}],
            'reportFormatType': {'code': 1}, 'qcConfigCheckItemList': [
                {'groupName': 'SYNTHETIC group', 'checkItemAppDetailVOS': rows}],
        }
        self.envelope = {'code': 200, 'needCheck': 0, 'data': {
            'id': 31, 'code': 'SYNTHETIC QC', 'qcConfig': config,
            'executor': {'id': 101}, 'checkType': {'code': 6}, 'getStatus': {'code': 1},
            'status': {'code': 1}, 'inspectionResult': None, 'beginTime': begin,
            'endTime': None, 'checkItems': [{'groupName': 'SYNTHETIC group',
                'qcTaskCheckItems': [self.record(401, 801, '10.100', begin),
                                     self.record(402, 802, '20.1', begin)]}],
            **{field: None for field in NULL_RELATIONS},
            **{field: [] for field in EMPTY_MATERIALS},
        }}
        data = parse_full_detail_json(self.raw())['data']
        pins = [DetailPin(('checkType', 'code'), 6), DetailPin(('getStatus', 'code'), 1)]
        pins.extend(DetailPin(('qcConfig', field), data['qcConfig'][field]) for field in CONFIG_FIELDS)
        for index, row in enumerate(data['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS']):
            path = ('qcConfig', 'qcConfigCheckItemList', 0, 'checkItemAppDetailVOS', index)
            pins.extend(DetailPin(path + (field,), row[field],
                                  'number' if field in {'min', 'max'} else 'exact')
                        for field in ITEM_FIELDS)
        pins.extend(DetailPin((field,), None) for field in NULL_RELATIONS)
        pins.extend(DetailPin((field,), []) for field in EMPTY_MATERIALS)
        self.review = FullDetailReview('SYNTHETIC QC', tuple(pins))

    @staticmethod
    def record(row_id, record_id, result, begin):
        return {'id': record_id, 'qcConfigCheckItemId': row_id, 'seq': 1,
                'result': result, 'operator': {'id': 101},
                'createdAt': begin + 1000, 'updatedAt': begin + 2000}

    def raw(self):
        return json.dumps(self.envelope, ensure_ascii=False, separators=(',', ':'))

    def decode(self, raw=None, review=None, binding=None):
        return decode_full_detail(self.raw() if raw is None else raw,
                                  binding=binding or self.binding,
                                  review=review or self.review, observed_at=self.at)

    def assert_blocked(self, code, callback=None):
        with self.assertRaises(FullSnapshotError) as caught:
            (callback or self.decode)()
        self.assertEqual(caught.exception.code, code)

    def test_exact_dto_keeps_full_configuration_raw_ms_and_lexical_result(self):
        result = self.decode()
        self.assertEqual(result, normalize_observation(result))
        self.assertEqual(len(self.review.pins), 64)
        self.assertEqual(len(result['config_keys']), 2)
        self.assertEqual(result['records'][0]['value'], '10.100')
        self.assertEqual(result['records'][0]['record_id'], '801')
        self.assertEqual(result['records'][0]['operator_id'], '101')
        self.assertEqual(result['records'][0]['created_at'],
                         self.envelope['data']['checkItems'][0]['qcTaskCheckItems'][0]['createdAt'])
        self.assertNotIn('id', self.envelope['data']['qcConfig'])

    def test_partial_and_empty_results_keep_complete_config_coverage(self):
        self.envelope['data']['checkItems'][0]['qcTaskCheckItems'].pop()
        result = self.decode()
        self.assertEqual(len(result['records']), 1)
        self.assertEqual(len(result['config_keys']), 2)
        self.envelope['data']['checkItems'] = []
        result = self.decode()
        self.assertEqual(result['records'], [])
        self.assertEqual(len(result['config_keys']), 2)

    def test_numeric_scale_progress_and_review_order_do_not_change_digest(self):
        before = self.decode()['config_digest']
        wire = self.raw().replace('"min":9.0', '"min":9.0000000000')
        self.assertEqual(self.decode(wire)['config_digest'], before)
        for row in self.envelope['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS']:
            row['filledReportCount'] = 1
            row['taskCheckCount'] = 1
        self.assertEqual(self.decode()['config_digest'], before)
        self.assertEqual(self.decode(review=replace(self.review, pins=tuple(reversed(self.review.pins))))['config_digest'], before)

    def test_missing_or_extra_config_cannot_be_disguised_as_partial_results(self):
        rows = self.envelope['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS']
        original = deepcopy(rows)
        rows.pop()
        self.assert_blocked('detail_configuration_mismatch')
        rows[:] = original + [deepcopy(original[0])]
        self.assert_blocked('detail_configuration_mismatch')

    def test_reviewed_config_sample_count_requires_every_mapped_sequence(self):
        row = self.envelope['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]
        row['totalReportCount'] = 2
        path = ('qcConfig', 'qcConfigCheckItemList', 0, 'checkItemAppDetailVOS', 0, 'totalReportCount')
        pins = tuple(DetailPin(pin.path, 2, pin.comparison) if pin.path == path else pin
                     for pin in self.review.pins)
        self.assert_blocked('detail_configuration_mismatch',
                            lambda: self.decode(review=replace(self.review, pins=pins)))

    def test_master_id_snapshot_executor_and_qc_identity_are_bound(self):
        for mutate in (
            lambda data: data.update(id=99),
            lambda data: data['qcConfig'].update(snapshotId=99),
            lambda data: data['executor'].update(id=99),
        ):
            with self.subTest(mutate=mutate):
                data = deepcopy(self.envelope['data'])
                mutate(self.envelope['data'])
                self.assert_blocked('mes_target_changed')
                self.envelope['data'] = data
        self.envelope['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]['checkItemId'] = 999
        self.assert_blocked('detail_configuration_mismatch')

    def test_immutable_bound_and_group_change_are_rejected(self):
        row = self.envelope['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]
        row['min'] = 9.1
        self.assert_blocked('detail_pinned_field_changed')
        row['min'] = 9.0
        row['groupName'] = 'SYNTHETIC other group'
        self.assert_blocked('detail_configuration_group_mismatch')

    def test_incomplete_and_progress_counter_pin_reviews_are_rejected(self):
        self.assert_blocked('detail_pin_coverage_invalid',
                            lambda: self.decode(review=replace(self.review, pins=self.review.pins[:-1])))
        path = ('qcConfig', 'qcConfigCheckItemList', 0, 'checkItemAppDetailVOS', 0, 'filledReportCount')
        pins = self.review.pins[:-1] + (DetailPin(path, 0),)
        self.assert_blocked('detail_pin_coverage_invalid',
                            lambda: self.decode(review=replace(self.review, pins=pins)))

    def test_review_cannot_authorize_production_or_material_relations(self):
        for field, value in [('workOrder', {'id': 99}), ('checkMaterials', [{'id': 99}])]:
            with self.subTest(field=field):
                self.envelope['data'][field] = value
                pins = tuple(DetailPin(pin.path, value, pin.comparison)
                             if pin.path == (field,) else pin for pin in self.review.pins)
                self.assert_blocked('unsupported_side_effects',
                                    lambda: self.decode(review=replace(self.review, pins=pins)))
                self.envelope['data'][field] = None if field in NULL_RELATIONS else []

    def test_duplicate_extra_and_unmapped_records_are_rejected(self):
        rows = self.envelope['data']['checkItems'][0]['qcTaskCheckItems']
        original = deepcopy(rows)
        rows.append(deepcopy(rows[0]))
        self.assert_blocked('detail_result_coverage_invalid')
        rows[:] = deepcopy(original)
        rows[1]['id'] = rows[0]['id']
        self.assert_blocked('detail_result_coverage_invalid')
        rows[:] = deepcopy(original)
        rows[1]['qcConfigCheckItemId'] = 999
        self.assert_blocked('detail_result_coverage_invalid')
        rows[:] = deepcopy(original)
        rows[1]['seq'] = 2
        self.assert_blocked('detail_result_coverage_invalid')

    def test_missing_record_operator_or_bad_time_never_becomes_a_readback(self):
        row = self.envelope['data']['checkItems'][0]['qcTaskCheckItems'][0]
        row.pop('operator')
        self.assert_blocked('detail_object_missing')
        row['operator'] = {'id': 101}
        row['updatedAt'] = row['createdAt'] - 1
        self.assert_blocked('detail_source_time_invalid')
        row['updatedAt'] = int(self.at.timestamp() * 1000) + 1
        self.assert_blocked('detail_source_time_invalid')

    def test_completed_pass_and_fail_require_end_time_and_keep_markers(self):
        before = self.decode()['records']
        data = self.envelope['data']
        data.update(status={'code': 2}, inspectionResult={'code': 1},
                    endTime=int((self.at - timedelta(seconds=1)).timestamp() * 1000))
        result = self.decode()
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(result['verdict'], 'pass')
        self.assertEqual(result['records'], before)
        data['inspectionResult'] = {'code': 4}
        self.assertEqual(self.decode()['verdict'], 'fail')
        data['endTime'] = None
        self.assert_blocked('detail_completion_unverified')

    def test_unstarted_unknown_and_inconsistent_open_states_fail(self):
        data = self.envelope['data']
        for code in (0, 3, 999):
            data['status'] = {'code': code}
            self.assert_blocked('detail_task_state_unverified')
        data['status'] = {'code': 1}
        data['beginTime'] = None
        self.assert_blocked('detail_integer_invalid')
        data['beginTime'] = int((self.at - timedelta(minutes=2)).timestamp() * 1000)
        data['inspectionResult'] = {'code': 1}
        self.assert_blocked('detail_task_state_unverified')

    def test_envelope_confirmation_is_explicit_and_boolean_zero_is_rejected(self):
        self.envelope['needCheck'] = False
        self.assert_blocked('detail_confirmation_unverified')
        self.envelope['needCheck'] = None
        self.assert_blocked('detail_confirmation_unverified')
        reviewed = replace(self.review, confirmation_policy=('zero', 'null', 'missing'))
        self.assertEqual(self.decode(review=reviewed)['state'], 'open')
        self.envelope.pop('needCheck')
        self.assertEqual(self.decode(review=reviewed)['state'], 'open')

    def test_duplicate_json_keys_nonfinite_and_float_ids_are_rejected(self):
        self.assert_blocked('duplicate_json_key', lambda: self.decode(self.raw().replace('"code":200', '"code":200,"code":200', 1)))
        self.assert_blocked('detail_nonfinite_number', lambda: self.decode(self.raw().replace('"min":9.0', '"min":NaN', 1)))
        self.envelope['data']['id'] = 31.0
        self.assert_blocked('detail_identity_invalid')

    def test_binding_duplicates_and_missing_mapping_are_rejected(self):
        binding = deepcopy(self.binding)
        binding.contract['items'][1] = deepcopy(binding.contract['items'][0])
        self.assert_blocked('invalid_mapping_coverage', lambda: self.decode(binding=binding))
        binding.contract['items'] = binding.contract['items'][:1]
        self.assert_blocked('invalid_mapping_coverage', lambda: self.decode(binding=binding))

    def test_observation_requires_aware_time_and_returns_only_fixed_error_codes(self):
        with self.assertRaises(FullSnapshotError) as caught:
            decode_full_detail(self.raw(), binding=self.binding, review=self.review,
                               observed_at=datetime.now())
        self.assertEqual(str(caught.exception), 'invalid_observation_time')
        self.assertEqual(self.decode()['observed_at'], self.at.isoformat())
