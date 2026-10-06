"""Public response tests with synthetic context and no database or MES reads."""
from copy import deepcopy
from datetime import date
from unittest.mock import patch

from django.test import SimpleTestCase
from rest_framework.test import APIRequestFactory

from production.test_inspection_status_projection import NOW, REVISION, row
from production.views import ProductionStatusView


class InspectionStatusViewTests(SimpleTestCase):
    def request(self, source):
        context = {
            'injection': {'machine_rows': [source], 'last_plan_updated_at': REVISION},
            'machining': {'rows': []},
        }
        original = deepcopy(context)
        with patch('production.views.get_daily_production_context', return_value=context) as loader, \
             patch('quality.inspection_board_repository.read_persisted_board_source', return_value=None), \
             patch('production.views.timezone.now', return_value=NOW):
            response = ProductionStatusView.as_view()(APIRequestFactory().get(
                '/api/production/status/', {'date': '2026-10-03'}))
        loader.assert_called_once_with(date(2026, 10, 3))
        self.assertEqual(context, original)
        self.assertEqual(response.status_code, 200)
        return response.data['injection'][0]

    def canonical(self):
        value = row()
        value.update(planned_qty=100, actual_qty=40, progress_rate=40,
                     recent_60m_shots=10, is_running=True)
        value['parts'][0].update(estimated_qty=40, allocated_shots=20, status='in-progress')
        return value

    def assert_legacy_metrics(self, result, expected_part_count=1):
        self.assertEqual(result['machine_name'], '850T-1')
        self.assertEqual(result['total_planned'], 100)
        self.assertEqual(result['total_actual'], 40)
        self.assertEqual(result['progress'], 40)
        self.assertEqual(result['shot_count'], 20)
        self.assertEqual(result['transition']['current_plan_id'], 70)
        self.assertEqual(len(result['parts']), expected_part_count)

    def test_public_view_adds_unavailable_projection_to_same_canonical_row(self):
        result = self.request(self.canonical())
        self.assert_legacy_metrics(result)
        self.assertEqual(result['machine_number'], 1)
        self.assertEqual(result['inspection_scope']['current_plan_id'], 70)
        self.assertEqual(result['inspection_status']['availability'], 'unavailable')
        self.assertEqual(result['inspection_status']['first']['status'], 'unknown')

    def test_overbound_quality_scope_preserves_all_production_rows(self):
        value = self.canonical()
        value['parts'] = [dict(value['parts'][0], plan_id=index + 1) for index in range(501)]
        result = self.request(value)
        self.assert_legacy_metrics(result, expected_part_count=501)
        self.assertIsNone(result['inspection_scope'])
        self.assertIsNone(result['inspection_status'])

    def test_optional_field_bound_does_not_hide_existing_production_metrics(self):
        value = self.canonical()
        value['parts'][0]['lot_no'] = 'SYNTHETIC-' * 60
        result = self.request(value)
        self.assert_legacy_metrics(result)
        self.assertEqual(result['parts'][0]['lot_no'], value['parts'][0]['lot_no'])
        self.assertIsNone(result['inspection_scope'])
        self.assertIsNone(result['inspection_status'])

    def test_provider_exception_preserves_public_view_and_redacts_error(self):
        with patch('quality.inspection_board_source.read_board_quality_source',
                   side_effect=RuntimeError('SYNTHETIC-PRIVATE-DIAGNOSTIC')):
            result = self.request(self.canonical())
        self.assert_legacy_metrics(result)
        self.assertEqual(result['inspection_status']['availability'], 'error')
        self.assertNotIn('SYNTHETIC-PRIVATE-DIAGNOSTIC', str(result))
