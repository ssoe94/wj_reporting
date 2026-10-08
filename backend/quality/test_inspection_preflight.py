"""Pure synthetic preflight tests: no Django, authentication, DB or network."""
from copy import deepcopy
from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
from pathlib import Path
import unittest

from .inspection_preflight import (
    PreflightMapping, PreflightTarget, TEST_LABEL_PREFIX, assess_detail_preflight,
)
from .inspection_read_snapshot import ReadScope


FIXTURE = json.loads((Path(__file__).parent / 'fixtures/blacklake_detail_synthetic.json').read_text(),
                    parse_float=Decimal)['response']
NOW = datetime(2001, 2, 1, 3, 4, 5, tzinfo=timezone.utc)
TARGET = PreflightTarget(ReadScope('SYNTHETIC_NAMESPACE', '91000000000000059', '91000000000000001'),
    '91000000000000058', '91000000000000004', '91000000000000005', 3,
    TEST_LABEL_PREFIX + 'SYNTHETIC-PREFLIGHT-ONLY')
# These paths/codes are fabricated test policy, not a reviewed live tenant mapping.
MAPPING = PreflightMapping(('qcConfig', 'materialBatchRecordType', 'code'),
    ('qcConfig', 'sampleProcessMethod', 'code'), ('syntheticPermanentLabel',),
    frozenset({41}), frozenset({57}), frozenset({73}), 'SYNTHETIC-MAPPING-REFERENCE')


class InspectionPreflightTests(unittest.TestCase):
    def source(self):
        response = deepcopy(FIXTURE)
        response['data']['qcConfig']['name'] = 'SYNTHETIC FIRST PLAN'
        response['data']['status'] = {'code': 73, 'message': 'SYNTHETIC OPEN'}
        response['data']['endTime'] = None
        response['data']['qcConfig']['materialBatchRecordType'] = {'code': 41}
        response['data']['qcConfig']['sampleProcessMethod'] = {'code': 57}
        response['data']['syntheticPermanentLabel'] = TARGET.permanent_test_label
        return response

    def assess(self, response=None, **overrides):
        options = dict(target=TARGET, mapping=MAPPING, observed_at=NOW,
            evaluated_at=NOW + timedelta(seconds=1), max_age=timedelta(minutes=1),
            evidence_kind='synthetic_contract_fixture', evidence_reference='SYNTHETIC-EVIDENCE')
        options.update(overrides)
        return assess_detail_preflight(self.source() if response is None else response, **options)

    def assert_blocked(self, result, code):
        self.assertEqual(result['detail_contract_status'], 'blocked')
        self.assertIn(code, result['blockers'])
        self.assertIs(result['can_save'], False)
        self.assertIs(result['can_finish'], False)

    def test_matching_contract_never_authorizes_execution_or_physical_effects(self):
        result = self.assess()
        self.assertEqual(result['detail_contract_status'], 'matched')
        for name in ('configuration', 'freshness', 'detail', 'identity',
                     'sample_configuration', 'permanent_source_label'):
            self.assertEqual(result['checks'][name], 'matched')
        for name in ('tenant', 'actual_actor_authority', 'approval_authority',
                     'production_side_effects', 'inventory_side_effects'):
            self.assertEqual(result['checks'][name], 'unverified')
            self.assertIn(name + '_unverified', result['blockers'])
        self.assertIn('live_execution_not_enabled', result['blockers'])
        self.assertIs(result['can_save'], False)
        self.assertIs(result['can_finish'], False)
        self.assertIs(result['read_only'], True)

    def test_required_sample_fields_are_missing_or_unsupported_never_defaulted(self):
        for field, code in (('materialBatchRecordType', 'material_batch_record_type'),
                            ('sampleProcessMethod', 'sample_process_method')):
            for value in ('absent', None, {}, {'code': None}, {'code': True}, {'code': 1.0},
                          {'code': '41'}, {'code': -1}, {'code': 999}, {'message': 'SYNTHETIC OK'}):
                with self.subTest(field=field, value=value):
                    source = self.source()
                    if value == 'absent':
                        source['data']['qcConfig'].pop(field)
                    else:
                        source['data']['qcConfig'][field] = value
                    result = self.assess(source)
                    self.assertEqual(result['detail_contract_status'], 'blocked')
                    self.assertTrue(any(reason.startswith(code + '_') for reason in result['blockers']))

    def test_label_requires_exact_source_readback_not_local_label_or_similar_text(self):
        for value in ('absent', None, '', TARGET.permanent_test_label[:-1], True,
                      {'label': TARGET.permanent_test_label}):
            with self.subTest(value=value):
                source = self.source()
                if value == 'absent':
                    source['data'].pop('syntheticPermanentLabel')
                else:
                    source['data']['syntheticPermanentLabel'] = value
                self.assertEqual(self.assess(source)['detail_contract_status'], 'blocked')
        self.assert_blocked(self.assess(target=replace(TARGET, permanent_test_label='ordinary label')),
                            'configuration_invalid')

    def test_every_target_relation_and_inspection_type_must_match(self):
        for field in ('production_task_id', 'equipment_id', 'snapshot_id'):
            with self.subTest(field=field):
                self.assert_blocked(self.assess(target=replace(TARGET, **{field: '9'})), 'identity_mismatch')
        for field in ('work_order_id', 'qc_id'):
            with self.subTest(field=field):
                target = replace(TARGET, scope=replace(TARGET.scope, **{field: '9'}))
                self.assert_blocked(self.assess(target=target), 'detail_invalid')
        self.assert_blocked(self.assess(target=replace(TARGET, check_type=5)), 'identity_mismatch')

    def test_closed_unknown_or_boolean_lifecycle_and_decoder_warnings_block(self):
        for value in (2, 999, None, True):
            source = self.source(); source['data']['status'] = value
            self.assertEqual(self.assess(source)['detail_contract_status'], 'blocked')
        source = self.source(); source['data']['qcConfig']['checkType'] = None
        self.assert_blocked(self.assess(source), 'detail_warnings_present')

    def test_freshness_requires_aware_finite_window_and_no_future_observation(self):
        cases = [({'observed_at': NOW.replace(tzinfo=None)}, 'observation_time_invalid'),
                 ({'evaluated_at': NOW.replace(tzinfo=None)}, 'observation_time_invalid'),
                 ({'observed_at': 'SYNTHETIC INVALID'}, 'observation_time_invalid'),
                 ({'max_age': 60}, 'observation_time_invalid'),
                 ({'max_age': timedelta(0)}, 'observation_time_invalid'),
                 ({'max_age': timedelta(seconds=-1)}, 'observation_time_invalid'),
                 ({'observed_at': NOW + timedelta(seconds=2)}, 'observation_in_future'),
                 ({'evaluated_at': NOW + timedelta(seconds=61)}, 'observation_expired')]
        for options, code in cases:
            with self.subTest(options=options): self.assert_blocked(self.assess(**options), code)
        self.assertEqual(self.assess(evaluated_at=NOW + timedelta(minutes=1))['detail_contract_status'], 'matched')

    def test_completed_evidence_cannot_be_redefined_as_open(self):
        for code in (2, 3):
            self.assert_blocked(self.assess(mapping=replace(MAPPING, open_lifecycle_codes=frozenset({code}))),
                                'configuration_invalid')
        source = self.source()
        source['data']['endTime'] = 981000000000
        self.assert_blocked(self.assess(source), 'completion_time_present')

    def test_invalid_paths_allowlists_and_unknown_configuration_fields_block(self):
        for path in ((), [], ('',), ('data.items[0]',), ('*',), ('a',) * 9, (1,)):
            with self.subTest(path=path):
                self.assert_blocked(self.assess(mapping=replace(MAPPING, material_batch_record_type_path=path)),
                                    'configuration_invalid')
        for codes in (frozenset(), {41}, frozenset({True}), frozenset({'41'}),
                      frozenset({-1}), frozenset(range(33))):
            with self.subTest(codes=codes):
                self.assert_blocked(self.assess(mapping=replace(MAPPING, supported_material_batch_record_types=codes)),
                                    'configuration_invalid')
        self.assert_blocked(self.assess(mapping=replace(MAPPING,
            sample_process_method_path=MAPPING.material_batch_record_type_path)), 'configuration_invalid')
        self.assert_blocked(self.assess(mapping=replace(MAPPING,
            sample_process_method_path=('qcConfig',))), 'configuration_invalid')
        invalid = asdict(MAPPING); invalid['allow_write'] = True
        self.assert_blocked(self.assess(mapping=invalid), 'configuration_invalid')
        with self.assertRaises(TypeError): PreflightMapping(**invalid)
        invalid_target = asdict(TARGET); invalid_target['authority_verified'] = True
        self.assert_blocked(self.assess(target=invalid_target), 'configuration_invalid')
        with self.assertRaises(TypeError): PreflightTarget(**invalid_target)

    def test_invalid_scope_identity_and_provenance_block_without_echoing_values(self):
        for value in ('01', '1e2', '0', '-1', '9223372036854775808', 1, True):
            self.assert_blocked(self.assess(target=replace(TARGET, snapshot_id=value)), 'configuration_invalid')
        for options in ({'evidence_kind': 'live_verified'}, {'evidence_kind': {}}, {'evidence_reference': ''},
                        {'mapping': replace(MAPPING, reference='')},
                        {'target': replace(TARGET, scope=replace(TARGET.scope, tenant=''))}):
            result = self.assess(**options)
            self.assertEqual(result['detail_contract_status'], 'blocked')
        scope = replace(TARGET.scope)
        object.__setattr__(scope, 'authority_verified', True)
        self.assert_blocked(self.assess(target=replace(TARGET, scope=scope)), 'configuration_invalid')

    def test_bad_response_and_confirmation_do_not_leak_error_text(self):
        for source in ([], {'code': 200}, {'code': True, 'data': {}}, {'code': 500, 'message': 'SECRET_ERROR'}):
            self.assert_blocked(self.assess(source), 'detail_invalid')
        for value in (1, True, False, '0'):
            source = self.source(); source['needCheck'] = value
            self.assert_blocked(self.assess(source), 'detail_invalid')

    def test_extra_actor_approval_and_side_effect_claims_cannot_unlock_writes(self):
        source = self.source()
        source['data'].update(actorId='9', receiveUserId='9', canSave=True, canFinish=True,
            approvalAuthorized=True, inventoryEffectsVerified=True, productionEffectsVerified=True)
        self.assertEqual(self.assess(source), self.assess())

    def test_input_is_immutable_and_output_contains_status_codes_only(self):
        source = self.source()
        source['access_token'] = 'SECRET-DO-NOT-RETURN'
        source['data']['unrecognized'] = {'nested': 'RAW-DO-NOT-RETURN'}
        before = deepcopy(source)
        result = self.assess(source, evidence_reference='PRIVATE-REFERENCE',
                             mapping=replace(MAPPING, reference='PRIVATE-MAPPING'))
        self.assertEqual(source, before)
        output = json.dumps(result)
        for forbidden in ('SECRET', 'RAW-DO-NOT-RETURN', 'PRIVATE', TARGET.scope.qc_id,
                          TARGET.scope.tenant, TARGET.permanent_test_label, '11.45', 'SYNTHETIC'):
            self.assertNotIn(forbidden, output)
        self.assertEqual(set(result), {'detail_contract_status', 'checks', 'blockers',
                                      'can_save', 'can_finish', 'read_only'})


if __name__ == '__main__':
    unittest.main()
