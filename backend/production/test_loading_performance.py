"""Synthetic query-budget and equivalence checks; never reads production data."""
from contextlib import ExitStack
from datetime import datetime, timedelta
from unittest.mock import patch

from django.db import DatabaseError, connection
from django.db.models import Max
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from injection.models import InjectionMonitoringRecord
from .ai_metrics import SHANGHAI_TZ
from .ai_retrievers import _injection_counter_windows, sum_positive_monitoring_delta
from .overview_board import build_overview_board_snapshot
from .test_overview_board import _activity_context, _production_context


class ProductionOverviewLoadingTests(TestCase):
    target = datetime(2026, 8, 10).date()
    auxiliary = (
        '_build_quality_attention', '_build_daily_plan_quality_items',
        'quality_summary_for_overview', '_build_energy', '_build_inventory',
        '_build_moulds', '_build_weather',
    )

    def context(self, stack):
        stack.enter_context(patch('production.overview_board.get_daily_production_context',
                                 return_value=_production_context(self.target)))
        stack.enter_context(patch('production.overview_board.get_injection_active_machine_context',
                                 return_value=_activity_context(self.target)))

    def test_production_scope_never_loads_auxiliary_sources(self):
        with ExitStack() as stack:
            self.context(stack)
            for name in self.auxiliary:
                stack.enter_context(patch(f'production.overview_board.{name}', side_effect=AssertionError(name)))
            with self.assertNumQueries(0):
                result = build_overview_board_snapshot(self.target, language='zh', scope='production')
        self.assertEqual(result['schema_version'], 'production-overview.v1')
        self.assertEqual(set(result['freshness']['sources']),
                         {'injection_production', 'assembly_production', 'injection_activity'})
        self.assertEqual(result['processes']['injection']['actual_qty'], 250)
        self.assertEqual(result['business_window']['timezone'], 'Asia/Shanghai')
        self.assertNotIn('weather', result)
        self.assertEqual(len(result['retrieval_trace']), 2)

    def test_full_and_production_scopes_share_exact_production_and_equipment(self):
        with ExitStack() as stack:
            self.context(stack)
            source = {'status': 'ok', 'source_latest_at': None, 'row_count': 0, 'stale': False}
            for name in ('_build_quality_attention', '_build_energy', '_build_inventory', '_build_moulds', '_build_weather'):
                stack.enter_context(patch(f'production.overview_board.{name}', return_value=({}, [], source, {})))
            stack.enter_context(patch('production.overview_board._build_daily_plan_quality_items', return_value=([], {})))
            stack.enter_context(patch('production.overview_board.quality_summary_for_overview', return_value={}))
            full = build_overview_board_snapshot(self.target, language='ko')
            focused = build_overview_board_snapshot(self.target, language='ko', scope='production')
        for key in ('processes', 'equipment', 'business_window'):
            self.assertEqual(focused[key], full[key], key)
        self.assertEqual(full['schema_version'], 'overview-board.v1')
        self.assertIn('weather', full)

    def test_core_database_failure_remains_explicit(self):
        with patch('production.overview_board.get_daily_production_context', side_effect=DatabaseError), patch(
            'production.overview_board.get_injection_active_machine_context', side_effect=DatabaseError,
        ):
            result = build_overview_board_snapshot(self.target, scope='production')
        self.assertIn('production_context_unavailable', result['warnings'])
        self.assertIn('injection_activity_context_unavailable', result['warnings'])
        self.assertEqual(result['freshness']['sources']['injection_activity']['status'], 'missing')
        self.assertTrue(all(trace['status'] == 'error' for trace in result['retrieval_trace']))

    def test_scope_endpoint_validates_before_retrieval_and_is_not_cached(self):
        client = APIClient()
        with patch('production.views.build_overview_board_snapshot', return_value={}) as build:
            invalid = client.get('/api/production/overview-board/', {'date': str(self.target), 'scope': 'unknown'})
            self.assertEqual(invalid.status_code, 400)
            build.assert_not_called()
            response = client.get('/api/production/overview-board/', {'date': str(self.target), 'scope': 'production', 'lang': 'zh'})
            build.assert_called_once_with(self.target, language='zh', scope='production')
        self.assertEqual(response.status_code, 200)
        self.assertIn('no-store', {directive.strip().lower() for directive in response['Cache-Control'].split(',')})


class InjectionCounterLoadingTests(TestCase):
    start = SHANGHAI_TZ.localize(datetime(2026, 9, 4, 8))

    def sample(self, machine, minutes, value):
        return InjectionMonitoringRecord.objects.create(
            machine_name=f'{machine}호기', device_code=f'loading-{machine}',
            timestamp=self.start + timedelta(minutes=minutes), capacity=value,
        )

    def reference(self, name, recent, end):
        return {
            'shots': sum_positive_monitoring_delta(name, 'capacity', self.start, end),
            'recent_shots': sum_positive_monitoring_delta(name, 'capacity', recent, end),
            'latest': InjectionMonitoringRecord.objects.filter(
                machine_name=name, timestamp__gte=self.start, timestamp__lt=end,
                capacity__isnull=False).aggregate(latest=Max('timestamp'))['latest'],
        }

    def test_batch_matches_existing_reducer_for_resets_nulls_and_boundaries(self):
        for machine, values in {
            1: [(-1, 90), (0, 100), (20, None), (40, 110), (60, 5), (90, 9), (120, 999)],
            2: [(0, 900), (60, 902), (90, 901)],
            3: [(-10, 800)],
            4: [(20, None)],
            5: [(-1, -2), (0, -1), (30, 0), (60, 5), (90, -1)],
        }.items():
            for minutes, value in values:
                self.sample(machine, minutes, value)
        recent, end = self.start + timedelta(minutes=60), self.start + timedelta(minutes=120)
        names = [f'{number}호기' for number in range(1, 6)]
        result = _injection_counter_windows(names, self.start, recent, end)
        for name in names:
            self.assertEqual(result[name], self.reference(name, recent, end), name)
        self.assertEqual(result['1호기']['shots'], 29)
        self.assertEqual(result['1호기']['recent_shots'], 9)

    def test_query_budget_is_two_for_one_or_seventeen_machines(self):
        for machine in range(1, 18):
            self.sample(machine, -1, 100)
            self.sample(machine, 0, 101)
            self.sample(machine, 60, 105)
        for count in (1, 17):
            names = [f'{number}호기' for number in range(1, count + 1)]
            with CaptureQueriesContext(connection) as queries:
                result = _injection_counter_windows(names, self.start,
                    self.start + timedelta(minutes=60), self.start + timedelta(minutes=61))
            self.assertEqual(len(queries), 2)
            self.assertEqual(len(result), count)
            self.assertTrue(all(row['shots'] == 5 and row['recent_shots'] == 4 for row in result.values()))
        with self.assertNumQueries(0):
            self.assertEqual(_injection_counter_windows([], self.start, self.start, self.start), {})
