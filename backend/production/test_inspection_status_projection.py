"""Synthetic integration seam tests; no Django, database, secrets or network."""
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
import json
import unittest
from unittest.mock import patch

from production.inspection_status_projection import build_inspection_board_fields
from quality.inspection_board_source import BoardQualitySource, read_board_quality_source
from quality.inspection_board_status import CurrentTaskBinding, QualityObservation, ReadState


NOW = datetime(2026, 10, 3, 4, tzinfo=timezone.utc)
DAY = date(2026, 10, 3)
REVISION = NOW - timedelta(hours=1)


def row(plan=70):
    return {'machine_number': 1, 'machine_name': '850T-1',
        'transition': {'current_plan_id': plan, 'confirmation_status': 'pending'},
        'parts': [{'plan_id': plan, 'part_no': 'TEST-PART', 'lot_no': 'TEST-LOT',
                   'sequence': 1, 'planned_qty': 100, 'cavity': 2}], 'shot_count': 20}


def source_for(scope):
    binding = CurrentTaskBinding('test-tenant', scope.machine_number, '10001', '20001', '30001',
        scope.current_plan_id, scope.business_date, scope.plan_version, 2, True,
        'synthetic-current-link', NOW - timedelta(hours=1), NOW + timedelta(hours=1))
    item = QualityObservation('test-tenant', '10001', '20001', '30001', '40001', '50001',
        'first', 'first', 'ended', 'passed', NOW - timedelta(minutes=10),
        NOW - timedelta(seconds=2), 'live_read', 'synthetic-contract')
    read = ReadState('ok', NOW, NOW, 4, True, 120,
        plan_version=scope.plan_version, binding_generation=2)
    return BoardQualitySource((binding,), (item,), read)


class InspectionStatusProjectionTests(unittest.TestCase):
    def fields(self, value=None, **kwargs):
        options = {'plan_updated_at': REVISION, 'now': NOW}
        options.update(kwargs)
        return build_inspection_board_fields(DAY, value or row(), **options)

    def test_default_source_is_unavailable_not_fixture_or_verified_mapping(self):
        captured = []
        def observe(scope):
            captured.append(scope)
            return read_board_quality_source(scope)
        with patch('quality.inspection_board_source.read_board_quality_source', side_effect=observe):
            value = self.fields()
        self.assertEqual(len(captured), 1)
        self.assertEqual(value['inspection_scope']['current_plan_id'], 70)
        status = value['inspection_status']
        self.assertEqual(status['availability'], 'unavailable')
        self.assertEqual(status['first']['status'], 'unknown')
        self.assertIsNone(status['fresh_until'])
        self.assertIsNone(status['refresh_after_seconds'])
        self.assertIsNone(status['last_success_at'])
        self.assertEqual(status['binding_status'], 'unresolved')

    def test_exact_scope_consumes_explicit_reviewed_source_without_leaking_ids(self):
        with patch('quality.inspection_board_source.read_board_quality_source', side_effect=source_for):
            value = self.fields()
        self.assertEqual(value['inspection_status']['first']['status'], 'passed')
        self.assertEqual(value['inspection_status']['plan_version'], value['inspection_scope']['plan_version'])
        for text in ('10001', '20001', '30001', '40001', '50001', 'test-tenant'):
            self.assertNotIn(text, json.dumps(value))

    def test_plan_switch_and_same_id_revision_invalidate_old_source(self):
        captured = []
        def capture(scope):
            captured.append(source_for(scope))
            return captured[-1]
        with patch('quality.inspection_board_source.read_board_quality_source', side_effect=capture):
            original = self.fields()
        for changed_row, revision in ((row(71), REVISION), (row(), REVISION + timedelta(seconds=1))):
            with self.subTest(plan=changed_row, revision=revision):
                with patch('quality.inspection_board_source.read_board_quality_source', return_value=captured[0]):
                    result = self.fields(changed_row, plan_updated_at=revision)
                self.assertNotEqual(original['inspection_scope']['plan_version'], result['inspection_scope']['plan_version'])
                self.assertEqual(result['inspection_status']['first']['status'], 'unknown')
                self.assertEqual(result['inspection_status']['first']['checks'], [])

    def test_telemetry_refresh_does_not_change_plan_version(self):
        original = self.fields()
        updated = row()
        updated['shot_count'] = 100
        updated['parts'][0]['allocated_shots'] = 100
        self.assertEqual(original['inspection_scope']['plan_version'], self.fields(updated)['inspection_scope']['plan_version'])

    def test_no_transition_or_ambiguous_local_id_has_no_fallback(self):
        absent = row()
        absent['transition'] = None
        duplicate = row()
        duplicate['parts'].append(dict(duplicate['parts'][0]))
        for value in (absent, duplicate):
            with self.subTest(value=value):
                self.assertIsNone(self.fields(value)['inspection_scope']['current_plan_id'])

    def test_failed_optional_source_does_not_reveal_error_or_modify_row(self):
        source = row()
        original = json.dumps(source, sort_keys=True)
        with patch('quality.inspection_board_source.read_board_quality_source', side_effect=RuntimeError('private-source-diagnostic')):
            value = self.fields(source)
        self.assertEqual(value['inspection_status']['availability'], 'error')
        self.assertIsNone(value['inspection_status']['last_attempt_completed_at'])
        self.assertNotIn('private-source-diagnostic', json.dumps(value))
        self.assertEqual(original, json.dumps(source, sort_keys=True))

    def test_fixture_provider_cannot_enable_current_status(self):
        def fixture_source(scope):
            value = source_for(scope)
            return replace(value, observations=(replace(value.observations[0], evidence_kind='synthetic_contract_fixture'),))
        with patch('quality.inspection_board_source.read_board_quality_source', side_effect=fixture_source):
            value = self.fields()['inspection_status']
        self.assertEqual(value['freshness'], 'fixture')
        self.assertEqual(value['first']['status'], 'unknown')

    def test_overbound_or_malformed_optional_scope_returns_no_identity(self):
        overbound = row()
        overbound['parts'] = [dict(overbound['parts'][0], plan_id=i + 1) for i in range(501)]
        malformed = row()
        malformed['parts'][0]['lot_no'] = {'unexpected': 'private-value'}
        for source in (overbound, malformed):
            original = json.dumps(source, sort_keys=True)
            with self.subTest(source=source), patch('quality.inspection_board_source.read_board_quality_source') as provider:
                value = self.fields(source)
            self.assertEqual(value, {'inspection_scope': None, 'inspection_status': None})
            provider.assert_not_called()
            self.assertEqual(original, json.dumps(source, sort_keys=True))


if __name__ == '__main__':
    unittest.main()
