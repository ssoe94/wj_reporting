"""Bounded workflow reads against disposable, entirely synthetic history.

Query budgets cover the GET and JSON rendering only, never fixture seeding or
assertion queries. Wall-clock timing is reported by the benchmark rather than
used as a flaky test threshold.
"""
import hashlib
import json
from unittest.mock import patch

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.test import TestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from inventory.models import RawMaterialMESDataset
from .models import (
    PlanMaterialApproval, PlanMaterialDefault, PlanMesRequest,
    PlanMesRequestEvent, PlanWorkflowLock, PlanWorkIdentity, PlanWorkOrder,
    PlanWorkRevision, ProductionExecution, ProductionPlan,
    ProductionPlanChangeLog,
)
from .workflow_performance_fixture import (
    measure_workflow_get, seed_performance_fixture,
)
from .plan_workflow_views import PlanWorkflowView
from .plan_workflow import digest
from .test_plan_workflow import approval_data


QUERY_BUDGET = 40
HISTORY_QUERY_GROWTH_BUDGET = 32
PLAN_TYPES = ('injection', 'machining')
PERSISTED_MODELS = (
    ProductionPlan, ProductionPlanChangeLog, ProductionExecution,
    PlanWorkflowLock, PlanWorkIdentity, PlanWorkRevision,
    PlanMaterialApproval, PlanMaterialDefault, PlanWorkOrder,
    PlanMesRequest, PlanMesRequestEvent, RawMaterialMESDataset,
)


def persisted_fingerprints():
    """Include every stored field so GET cannot silently rewrite history."""
    result = {}
    for model in PERSISTED_MODELS:
        rows = list(model.objects.order_by(model._meta.pk.name).values())
        encoded = json.dumps(rows, cls=DjangoJSONEncoder, sort_keys=True,
                             separators=(',', ':')).encode()
        result[model._meta.label] = (len(rows), hashlib.sha256(encoded).hexdigest())
    return result


class NoMesNetworkMixin:
    def setUp(self):
        super().setUp()
        guard = patch('requests.sessions.Session.request',
                      side_effect=AssertionError('MES network forbidden in performance tests'))
        guard.start()
        self.addCleanup(guard.stop)

    def assert_read_budget(self, measured):
        self.assertEqual(measured['write_queries'], [], 'GET must not write to its database')
        self.assertLessEqual(measured['query_count'], QUERY_BUDGET,
                             f"workflow GET used {measured['query_count']} SQL statements")
        self.assertFalse(measured['data']['write_enabled'])


class PlanWorkflowPerformanceTests(NoMesNetworkMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        with patch('requests.sessions.Session.request',
                   side_effect=AssertionError('MES network forbidden in synthetic seeding')):
            cls.fixture = seed_performance_fixture(total_plans=5611)

    def row_for(self, data, name):
        uid = str(self.fixture['named'][name].work_uid)
        matching = [row for row in data['rows'] if row['uid'] == uid]
        self.assertEqual(len(matching), 1, f'{name} must remain a visible scoped row')
        return matching[0]

    def group_for(self, data, name):
        uid = str(self.fixture['named'][name].work_uid)
        matching = [group for group in data['preview'] if uid in group['members']]
        self.assertEqual(len(matching), 1, f'{name} must appear in exactly one preview')
        return matching[0]

    def post(self, plan_type, body):
        request = APIRequestFactory().post('/api/production/plan-workflow/', {
            'start': str(self.fixture['start']), 'end': str(self.fixture['end']),
            'plan_type': plan_type, **body,
        }, format='json')
        force_authenticate(request, user=self.fixture['user'])
        return PlanWorkflowView.as_view()(request)

    def test_full_history_get_is_bounded_and_has_no_database_writes(self):
        self.assertEqual(ProductionPlan.objects.count(), 5611)
        for plan_type in PLAN_TYPES:
            with self.subTest(plan_type=plan_type):
                self.assert_read_budget(measure_workflow_get(self.fixture, plan_type))

    def test_repeated_get_preserves_response_and_all_persisted_history(self):
        before = persisted_fingerprints()
        for plan_type in PLAN_TYPES:
            with self.subTest(plan_type=plan_type):
                first = measure_workflow_get(self.fixture, plan_type)
                second = measure_workflow_get(self.fixture, plan_type)
                self.assert_read_budget(first)
                self.assert_read_budget(second)
                self.assertEqual(first['response_sha256'], second['response_sha256'])
                self.assertEqual(first['response_bytes'], second['response_bytes'])
                self.assertEqual(first['data'], second['data'])
        self.assertEqual(persisted_fingerprints(), before)

    def test_injection_boundaries_approval_defaults_and_replay_fence_survive_history(self):
        measured = measure_workflow_get(self.fixture, 'injection')
        self.assert_read_budget(measured)
        data = measured['data']
        self.assertEqual(len(data['rows']), 9)
        self.assertEqual(len(data['preview']), 7)
        campaign = self.group_for(data, 'campaign_8')
        self.assertEqual(campaign['members'], [
            str(self.fixture['named'][f'campaign_{day}'].work_uid) for day in (8, 9, 10)])
        self.assertEqual(campaign['quantity'], '2300.0')
        self.assertEqual(campaign['planned_start'], '2026-10-08T08:00:00+08:00')
        self.assertEqual(campaign['planned_end'], '2026-10-11T08:00:00+08:00')
        self.assertEqual(campaign['blockers'], [])
        approved = self.row_for(data, 'campaign_8')
        self.assertEqual(approved['approval']['actor_name'], 'SYNTHETIC')
        self.assertEqual(approved['approval']['snapshot']['inputs'][0]['material_id'], '17000000000000001')
        self.assertEqual(approved['approval']['snapshot']['inputs'][0]['unit_id'], '17000000000000002')
        self.assertEqual(approved['default_version'], 2)
        self.assertEqual(approved['recommendation']['version'], 1)

        legacy = self.row_for(data, 'legacy')
        self.assertEqual(legacy['planned_quantity'], '123.4567890123456')
        self.assertFalse(legacy['quantity_valid'])
        self.assertIn('plan_quantity_review', self.group_for(data, 'legacy')['blockers'])
        revision = self.row_for(data, 'revision')
        self.assertEqual(revision['version'], 2)
        self.assertIsNone(revision['approval'])
        self.assertIsNotNone(revision['previous_approval'])
        self.assertIn('below_existing_execution_review', self.group_for(data, 'revision')['blockers'])
        for name in ('duplicate_a', 'duplicate_b'):
            group = self.group_for(data, name)
            self.assertEqual(group['members'], [str(self.fixture['named'][name].work_uid)])
            self.assertIn('multiple_rows_setup_review', group['blockers'])
        identity = self.row_for(data, 'identity')
        self.assertEqual(identity['identity_state'], 'confirmation')
        self.assertEqual(len(identity['candidate_details']), 1)
        self.assertEqual(identity['candidate_details'][0]['uid'], identity['candidates'][0])
        self.assertIn('identity_confirmation', self.group_for(data, 'identity')['blockers'])
        uncertain = self.group_for(data, 'uncertain')
        self.assertEqual(uncertain['mes_id'], '17000000000000009')
        self.assertIn('readback_required', uncertain['blockers'])
        self.assertEqual({request['state'] for request in data['requests']}, {
            'disabled', 'sending', 'uncertain', 'readback_pending',
            'review', 'confirmed', 'superseded',
        })

    def test_machining_daily_sequence_and_execution_guards_survive_history(self):
        measured = measure_workflow_get(self.fixture, 'machining')
        self.assert_read_budget(measured)
        data = measured['data']
        self.assertEqual(len(data['rows']), 8)
        self.assertEqual(len(data['preview']), 8)
        for name, day, quantity in (('machining_8', 8, '1000.0'), ('machining_9', 9, '500.0')):
            group = self.group_for(data, name)
            self.assertEqual(group['members'], [str(self.fixture['named'][name].work_uid)])
            self.assertEqual(group['quantity'], quantity)
            self.assertEqual(group['planned_start'], f'2026-10-{day:02}T08:00:00+08:00')
            self.assertEqual(group['planned_end'], f'2026-10-{day + 1:02}T08:00:00+08:00')
            self.assertEqual(group['blockers'], [])
        revision = self.row_for(data, 'machining_revision')
        self.assertIsNone(revision['approval'])
        self.assertIsNotNone(revision['previous_approval'])
        for name in ('machining_revision', 'machining_execution'):
            self.assertIn('below_existing_execution_review', self.group_for(data, name)['blockers'])
        self.assertIn('identity_confirmation', self.group_for(data, 'machining_identity')['blockers'])
        observed = self.group_for(data, 'machining_observed')
        self.assertEqual(observed['quantity'], '1000.0')
        self.assertEqual(observed['mes_id'], '17000000000000009')
        self.assertIn('below_produced_or_inbound', observed['blockers'])
        for name in ('machining_sequence_a', 'machining_sequence_b'):
            group = self.group_for(data, name)
            self.assertEqual(group['members'], [str(self.fixture['named'][name].work_uid)])
            self.assertNotIn('multiple_rows_setup_review', group['blockers'])

    def test_stale_approval_and_unknown_preview_key_do_not_change_history(self):
        before = persisted_fingerprints()
        plan = self.fixture['named']['revision']
        body = approval_data(plan)
        body.update(action='approve', plan_id=plan.pk, version=1)
        stale = self.post('injection', body)
        self.assertEqual(stale.status_code, 409)
        invalid_preview = self.post('injection', {'action': 'prepare', 'keys': ['0' * 64]})
        self.assertEqual(invalid_preview.status_code, 409)
        self.assertEqual(persisted_fingerprints(), before)

    def test_prepare_retries_keep_one_request_and_preserve_uncertain_work(self):
        measured = measure_workflow_get(self.fixture, 'injection')
        self.assert_read_budget(measured)
        campaign = self.group_for(measured['data'], 'campaign_8')
        uncertain = self.group_for(measured['data'], 'uncertain')
        self.assertEqual(campaign['operation'], 'prepare')
        replay_order = PlanWorkOrder.objects.get(code=uncertain['work_order_code'])
        replay_before = list(replay_order.requests.order_by('uid').values())
        replay_events = list(PlanMesRequestEvent.objects.filter(request__work_order=replay_order).order_by('pk').values())
        original_order_count = PlanWorkOrder.objects.count()
        first = self.post('injection', {
            'action': 'prepare', 'keys': [campaign['key'], uncertain['key']],
        })
        self.assertEqual(first.status_code, 200)
        results = {item['key']: item for item in first.data['results']}
        self.assertEqual(results[campaign['key']]['state'], 'disabled')
        self.assertEqual(results[uncertain['key']]['state'], 'blocked')
        self.assertIn('readback_required', results[uncertain['key']]['blockers'])
        prepared_uid = results[campaign['key']]['uid']
        request_count = PlanMesRequest.objects.count()
        event_count = PlanMesRequestEvent.objects.count()
        fresh = measure_workflow_get(self.fixture, 'injection')
        self.assert_read_budget(fresh)
        latest = self.group_for(fresh['data'], 'campaign_8')
        self.assertEqual(latest['operation'], 'unchanged')
        for key in (campaign['key'], latest['key']):
            repeated = self.post('injection', {'action': 'prepare', 'keys': [key]})
            self.assertEqual(repeated.status_code, 200)
            self.assertEqual(repeated.data['results'][0]['state'], 'unchanged')
        self.assertEqual(PlanMesRequest.objects.count(), request_count)
        self.assertEqual(PlanMesRequestEvent.objects.count(), event_count)
        self.assertEqual(PlanWorkOrder.objects.count(), original_order_count)
        self.assertEqual(PlanMesRequest.objects.get(uid=prepared_uid).attempt, 0)
        self.assertEqual(list(replay_order.requests.order_by('uid').values()), replay_before)
        self.assertEqual(list(PlanMesRequestEvent.objects.filter(request__work_order=replay_order).order_by('pk').values()), replay_events)


class PlanWorkflowHistoryGrowthTests(NoMesNetworkMixin, TestCase):
    def measure_history_size(self, total_plans):
        # Roll back each seed independently: identities and approval/default
        # history from the small run cannot contaminate the large run.
        with transaction.atomic():
            fixture = seed_performance_fixture(total_plans=total_plans)
            self.assertEqual(ProductionPlan.objects.count(), total_plans)
            measured = {plan_type: measure_workflow_get(fixture, plan_type)
                        for plan_type in PLAN_TYPES}
            transaction.set_rollback(True)
        return measured

    def test_query_count_does_not_scale_with_unrelated_history(self):
        small = self.measure_history_size(100)
        large = self.measure_history_size(5611)
        for plan_type in PLAN_TYPES:
            with self.subTest(plan_type=plan_type):
                self.assert_read_budget(small[plan_type])
                self.assert_read_budget(large[plan_type])
                growth = large[plan_type]['query_count'] - small[plan_type]['query_count']
                self.assertLessEqual(growth, HISTORY_QUERY_GROWTH_BUDGET,
                                     f"100 to 5611 plans added {growth} SQL statements")
                self.assertEqual(small[plan_type]['response_sha256'],
                                 large[plan_type]['response_sha256'],
                                 'Unrelated history must not change the scoped response')
                self.assertEqual(small[plan_type]['response_bytes'],
                                 large[plan_type]['response_bytes'])
                self.assertEqual(small[plan_type]['data'], large[plan_type]['data'])


class PlanWorkflowHistoryCapTests(NoMesNetworkMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        with patch('requests.sessions.Session.request',
                   side_effect=AssertionError('MES network forbidden in synthetic seeding')):
            cls.fixture = seed_performance_fixture(
                total_plans=12011, selected_history_limit=6000)

    def test_selected_history_over_cap_keeps_current_rows_visible_and_preparation_fenced(self):
        self.assertEqual(ProductionPlan.objects.count(), 12011)
        before = persisted_fingerprints()
        request_count = PlanMesRequest.objects.count()
        for plan_type, machine, row_count, order_code in (
            ('injection', 'imm01', 9, 'SYNTHETIC-PERF-campaign'),
            ('machining', 'line01', 8, 'SYNTHETIC-PERF-machining-observed'),
        ):
            with self.subTest(plan_type=plan_type):
                old_history_count = ProductionPlan.objects.filter(
                    plan_type=plan_type, machine_name=machine,
                    plan_date__lt=self.fixture['start']).count()
                self.assertGreater(old_history_count, 5000)
                measured = measure_workflow_get(self.fixture, plan_type)
                self.assert_read_budget(measured)
                data = measured['data']
                self.assertEqual(len(data['rows']), row_count)
                expected_uids = {str(plan.work_uid) for plan in self.fixture['named'].values()
                                 if plan.plan_type == plan_type}
                self.assertEqual({row['uid'] for row in data['rows']}, expected_uids,
                                 'The preview safety cap must not hide current plan rows')
                previews = data['preview']
                if previews:
                    for group in previews:
                        self.assertIn('plan_scope_truncated', group['blockers'])
                    keys = [group['key'] for group in previews]
                else:
                    # The established date-ordered preview cap may stop before
                    # all current rows. A previously valid persisted order key
                    # must then remain unusable rather than bypass that cap.
                    order = PlanWorkOrder.objects.get(code=order_code)
                    keys = [digest(order.approved_snapshot)]
                request = APIRequestFactory().post('/api/production/plan-workflow/', {
                    'start': str(self.fixture['start']), 'end': str(self.fixture['end']),
                    'plan_type': plan_type, 'action': 'prepare', 'keys': keys,
                }, format='json')
                force_authenticate(request, user=self.fixture['user'])
                response = PlanWorkflowView.as_view()(request)
                if previews:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(len(response.data['results']), len(previews))
                    for result in response.data['results']:
                        self.assertEqual(result['state'], 'blocked')
                        self.assertIn('plan_scope_truncated', result['blockers'])
                else:
                    self.assertEqual(response.status_code, 409)
                self.assertEqual(PlanMesRequest.objects.count(), request_count)
        self.assertEqual(persisted_fingerprints(), before)
