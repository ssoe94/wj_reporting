"""Deep-tier analysis: registry, weekly scheduling, input packs, grounding,
claim routing, worker status tiers and queue priority."""

from datetime import date, datetime, timedelta
from unittest import mock

from django.apps import apps
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.state import ProjectState
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from production.ai_metrics import SHANGHAI_TZ
from production.models import ProductionPlan
from production.views import is_production_ai_model_available
from quality.models import QualityReport

from . import views as ai_views
from .deep_analysis import (
    DEEP_ANALYSIS_INPUT_SCHEMA_VERSION,
    DEEP_ANALYSIS_KIND_PRODUCTION_WEEKLY,
    DEEP_ANALYSIS_KIND_QUALITY_WEEKLY,
    DEEP_ANALYSIS_RESULT_SCHEMA_VERSION,
    DEEP_ANALYSIS_RESULT_SOURCE,
    DEEP_ANALYSIS_JOB_TIMEOUT_SECONDS,
    build_deep_analysis_input,
    canonical_number_token,
    collect_evidence_numbers,
    enqueue_weekly_deep_analysis,
    previous_week_period,
    restore_authoritative_deep_analysis_result,
    weekly_deep_analysis_due,
)
from .model_registry import (
    AI_MODEL_DISPLAY_NAMES,
    AI_MODEL_TIERS,
    AI_WORKER_CAPABILITY_MODEL_IDS,
    DEEP_ANALYSIS_MODEL_ID,
    LOCAL_AI_MODEL_ID,
    SUPPORTED_AI_WORKER_VERSION,
    SUPPORTED_AI_WORKER_VERSIONS,
    display_model_name,
    is_supported_worker_version,
    model_display_name,
    worker_tier_for_model_ids,
)
from .models import AiJob
from .quality_daily import QUALITY_DAILY_MODE, QUALITY_DAILY_TRIGGER
from .quality_report_audit import QUALITY_REPORT_AUDIT_MODE, QUALITY_REPORT_AUDIT_TRIGGER


WORKER_HEADERS = {'HTTP_X_AI_WORKER_TOKEN': 'test-worker-token'}


def shanghai(year, month, day, hour=0, minute=0):
    return SHANGHAI_TZ.localize(datetime(year, month, day, hour, minute))


def deep_scope(kind='production_weekly', language='ko', trigger='weekly', period_end=date(2026, 9, 13)):
    return {
        'kind': kind,
        'language': language,
        'period_start': (period_end - timedelta(days=6)).isoformat(),
        'period_end': period_end.isoformat(),
        'trigger': trigger,
        'model_id': DEEP_ANALYSIS_MODEL_ID,
    }


def create_heartbeat(worker_name, model_ids, *, model_name, version=SUPPORTED_AI_WORKER_VERSION, age=None, llm_ready=True):
    heartbeat = AiJob.objects.create(
        job_type='worker_heartbeat',
        status=AiJob.STATUS_COMPLETED,
        scope={'trigger': 'worker_heartbeat', 'worker_name': worker_name},
        result_payload={
            'llm_enabled': True,
            'llm_ready': llm_ready,
            'model_name': model_name,
            'worker_version': version,
            'last_error': '',
            'available_model_ids': list(model_ids),
        },
        claimed_by=worker_name,
        completed_at=timezone.now(),
    )
    if age is not None:
        AiJob.objects.filter(pk=heartbeat.pk).update(completed_at=timezone.now() - age)
        heartbeat.refresh_from_db()
    return heartbeat


class ModelRegistryTests(TestCase):
    def test_registry_constants_match_the_contract(self):
        self.assertEqual(LOCAL_AI_MODEL_ID, 'qwen38')
        self.assertEqual(DEEP_ANALYSIS_MODEL_ID, 'claude')
        self.assertEqual(AI_MODEL_TIERS, {'qwen38': 'local', 'claude': 'deep'})
        self.assertEqual(AI_MODEL_DISPLAY_NAMES, {'qwen38': 'Qwen 3.8 27B', 'claude': 'Claude'})
        self.assertEqual(AI_WORKER_CAPABILITY_MODEL_IDS, ('qwen38', 'claude'))
        self.assertEqual(SUPPORTED_AI_WORKER_VERSION, 'production-ai-worker-v2')
        self.assertIn(SUPPORTED_AI_WORKER_VERSION, SUPPORTED_AI_WORKER_VERSIONS)
        self.assertTrue(is_supported_worker_version('production-ai-worker-v2'))
        self.assertFalse(is_supported_worker_version('production-ai-worker-v1'))
        self.assertFalse(is_supported_worker_version(None))

    def test_display_name_helpers(self):
        self.assertEqual(display_model_name('/private/models/Qwen3.8-27B-4bit'), 'Qwen3.8-27B-4bit')
        self.assertEqual(display_model_name('C:\\models\\Qwen3.8'), 'Qwen3.8')
        self.assertEqual(model_display_name('qwen38', '/private/models/Qwen3.8-27B-4bit'), 'Qwen 3.8 27B')
        self.assertEqual(model_display_name('claude'), 'Claude')
        self.assertEqual(model_display_name('unknown-id', '/models/Other-7B'), 'Other-7B')
        self.assertEqual(model_display_name(None, ''), '')
        self.assertEqual(worker_tier_for_model_ids(['qwen38']), 'local')
        self.assertEqual(worker_tier_for_model_ids(['claude']), 'deep')
        self.assertEqual(worker_tier_for_model_ids([]), 'local')
        # Compatibility re-export for existing callers.
        self.assertIs(ai_views.display_model_name, display_model_name)


class DeepAnalysisMigrationTests(TestCase):
    def test_job_type_choice_is_migrated_additively(self):
        self.assertIn(
            (AiJob.JOB_TYPE_DEEP_ANALYSIS, 'Deep Analysis'),
            AiJob.JOB_TYPE_CHOICES,
        )
        executor = MigrationExecutor(connection)
        applied = {name for app, name in executor.loader.applied_migrations if app == 'ai_core'}
        self.assertIn('0002_deep_analysis_job_type', applied)
        autodetector = MigrationAutodetector(
            executor.loader.project_state(),
            ProjectState.from_apps(apps),
        )
        changes = autodetector.changes(graph=executor.loader.graph)
        self.assertNotIn('ai_core', changes)


class EvidenceNumberTests(TestCase):
    def test_collects_numbers_from_values_keys_and_strings(self):
        numbers = collect_evidence_numbers({
            'facts': {'actual_qty': 1200, 'progress_rate': 63.2, 'ok': True, 'flag': None},
            'labels': ['850T-1', '2026-09-15', 'no numbers'],
            '3_key': -25,
        })
        for token in ('1200', '63.2', '63', '850', '1', '2026', '09', '15', '3', '25'):
            self.assertIn(token, numbers)
        self.assertNotIn('True', numbers)
        self.assertEqual(numbers, sorted(set(numbers), key=lambda t: (len(t), t)))

    def test_canonical_forms_ground_natural_date_and_decimal_prose(self):
        # "2026-09-08" is quoted as 9월 8일 / 9月8日; "63.0" as 63.
        numbers = collect_evidence_numbers({'date': '2026-09-08', 'rate': 63.0, 'share': 12.50})
        for token in ('09', '9', '08', '8', '63', '12.5'):
            self.assertIn(token, numbers)
        self.assertEqual(canonical_number_token('09'), '9')
        self.assertEqual(canonical_number_token('0'), '0')
        self.assertEqual(canonical_number_token('63.0'), '63')
        self.assertEqual(canonical_number_token('63.40'), '63.4')

    def test_metric_definition_constants_are_evidence(self):
        with mock.patch('ai_core.deep_analysis._production_day', return_value={'date': '2026-09-07', 'included': True}):
            payload = build_deep_analysis_input('production_weekly', 'ko', date(2026, 9, 7), date(2026, 9, 7))
        # 08:00 business day, 24-hour time progress and the 5 %p threshold from
        # metric_definitions must not be "ungrounded" when quoted.
        for token in ('8', '24', '5'):
            self.assertIn(token, payload['evidence_numbers'])


class WeeklyScheduleTests(TestCase):
    def test_due_only_from_monday_08_shanghai(self):
        self.assertFalse(weekly_deep_analysis_due(shanghai(2026, 9, 14, 7, 59)))  # Monday
        self.assertTrue(weekly_deep_analysis_due(shanghai(2026, 9, 14, 8, 0)))
        self.assertTrue(weekly_deep_analysis_due(shanghai(2026, 9, 16, 12, 0)))  # catch-up on Wednesday
        # Sunday night is still "due" for the week that started the previous
        # Monday; its period is the week before that, already created.
        self.assertTrue(weekly_deep_analysis_due(shanghai(2026, 9, 13, 23, 30)))
        self.assertEqual(
            previous_week_period(shanghai(2026, 9, 13, 23, 30)),
            (date(2026, 8, 31), date(2026, 9, 6)),
        )

    def test_period_is_previous_monday_to_sunday(self):
        self.assertEqual(
            previous_week_period(shanghai(2026, 9, 16, 12, 0)),
            (date(2026, 9, 7), date(2026, 9, 13)),
        )
        self.assertEqual(
            previous_week_period(shanghai(2026, 9, 14, 0, 30)),
            (date(2026, 9, 7), date(2026, 9, 13)),
        )

    @mock.patch('ai_core.deep_analysis.build_deep_analysis_input')
    def test_weekly_enqueue_is_idempotent_and_bounded_per_call(self, build_input):
        build_input.side_effect = lambda kind, language, start, end: {
            'schema_version': DEEP_ANALYSIS_INPUT_SCHEMA_VERSION,
            'kind': kind,
            'language': language,
            'period': {'start': start.isoformat(), 'end': end.isoformat()},
            'evidence_numbers': [],
        }
        before = enqueue_weekly_deep_analysis(shanghai(2026, 9, 14, 7, 30))
        self.assertFalse(before['due'])
        self.assertEqual(AiJob.objects.filter(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS).count(), 0)

        first = enqueue_weekly_deep_analysis(shanghai(2026, 9, 14, 8, 0))
        self.assertTrue(first['due'])
        self.assertEqual(first['created_count'], 1)
        self.assertEqual(len(first['pending_pairs']), 3)
        self.assertEqual((first['period_start'], first['period_end']), ('2026-09-07', '2026-09-13'))

        rest = enqueue_weekly_deep_analysis(shanghai(2026, 9, 14, 8, 5), max_jobs_per_call=10)
        self.assertEqual(rest['created_count'], 3)
        again = enqueue_weekly_deep_analysis(shanghai(2026, 9, 15, 9, 0), max_jobs_per_call=10)
        self.assertEqual(again['created_count'], 0)
        self.assertEqual(len(again['existing_job_ids']), 4)

        jobs = AiJob.objects.filter(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS)
        self.assertEqual(jobs.count(), 4)
        self.assertEqual(
            {(job.scope['kind'], job.scope['language']) for job in jobs},
            {
                ('production_weekly', 'ko'), ('production_weekly', 'zh'),
                ('quality_weekly', 'ko'), ('quality_weekly', 'zh'),
            },
        )
        for job in jobs:
            self.assertEqual(job.scope['trigger'], 'weekly')
            self.assertEqual(job.scope['model_id'], 'claude')
            self.assertEqual(job.scope['period_start'], '2026-09-07')
            self.assertEqual(job.scope['period_end'], '2026-09-13')
            self.assertIsNone(job.created_by)
            self.assertEqual(job.input_payload['kind'], job.scope['kind'])

        # A new week creates the next period without touching the old one.
        next_week = enqueue_weekly_deep_analysis(shanghai(2026, 9, 21, 8, 0), max_jobs_per_call=10)
        self.assertEqual(next_week['created_count'], 4)
        self.assertEqual((next_week['period_start'], next_week['period_end']), ('2026-09-14', '2026-09-20'))

    @mock.patch('ai_core.deep_analysis.build_deep_analysis_input')
    def test_weekly_enqueue_retries_a_failed_pair_once(self, build_input):
        build_input.side_effect = lambda kind, language, start, end: {'kind': kind, 'language': language, 'evidence_numbers': []}
        enqueue_weekly_deep_analysis(shanghai(2026, 9, 14, 8, 0), max_jobs_per_call=10)
        pair = AiJob.objects.filter(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS, scope__kind='production_weekly', scope__language='ko')
        first = pair.get()
        AiJob.objects.filter(pk=first.pk).update(status=AiJob.STATUS_FAILED, error_message='Bridge validation failed')

        retry = enqueue_weekly_deep_analysis(shanghai(2026, 9, 14, 9, 0), max_jobs_per_call=10)
        self.assertEqual(retry['created_count'], 1)
        self.assertEqual(pair.count(), 2)
        second = pair.order_by('-id').first()
        self.assertEqual(second.status, AiJob.STATUS_PENDING)

        # A second failure is final: no third attempt for the same period.
        AiJob.objects.filter(pk=second.pk).update(status=AiJob.STATUS_FAILED)
        final = enqueue_weekly_deep_analysis(shanghai(2026, 9, 15, 9, 0), max_jobs_per_call=10)
        self.assertEqual(final['created_count'], 0)
        self.assertIn(second.pk, final['existing_job_ids'])
        self.assertEqual(pair.count(), 2)


class DeepAnalysisInputTests(TestCase):
    def setUp(self):
        cache.clear()

    def test_production_weekly_prefers_completed_hourly_snapshot(self):
        briefing = {
            'answer': 'prose that must not be copied',
            'severity': 'warning',
            'facts': {'injection': {'actual_qty': 1234, 'planned_qty': 2000, 'progress_rate': 61.7}},
            'top_risks': [{'type': 'machine_gap', 'label': '850T-1', 'gap_qty': -321}],
            'used_data': [{'name': 'ProductionPlan', 'row_count': 9}],
            'calculation_basis': ['x'],
            'data_freshness': {'is_stale': False, 'last_mes_recorded_at': '2026-09-09T07:55:00+08:00'},
            'warnings': ['injection_mes_data_stale'],
            'retrieval_trace': ['production.plan:date=2026-09-09'],
        }
        older = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={'date': '2026-09-09', 'language': 'ko', 'trigger': 'hourly', 'model_id': 'qwen38'},
            input_payload={'briefing': {**briefing, 'facts': {'injection': {'actual_qty': 1}}}},
            completed_at=timezone.now() - timedelta(hours=2),
        )
        newest = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={'date': '2026-09-09', 'language': 'ko', 'trigger': 'hourly', 'model_id': 'qwen38'},
            input_payload={'briefing': briefing},
            completed_at=timezone.now() - timedelta(hours=1),
        )
        AiJob.objects.create(  # other language must not be used
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={'date': '2026-09-10', 'language': 'zh', 'trigger': 'hourly', 'model_id': 'qwen38'},
            input_payload={'briefing': briefing},
            completed_at=timezone.now(),
        )

        payload = build_deep_analysis_input('production_weekly', 'ko', date(2026, 9, 7), date(2026, 9, 13))

        self.assertEqual(payload['schema_version'], DEEP_ANALYSIS_INPUT_SCHEMA_VERSION)
        self.assertEqual(payload['kind'], 'production_weekly')
        self.assertEqual(payload['language'], 'ko')
        self.assertEqual(payload['model_id'], 'claude')
        self.assertEqual(payload['period']['start'], '2026-09-07')
        self.assertEqual(payload['period']['end'], '2026-09-13')
        self.assertEqual(payload['period']['day_count'], 7)
        self.assertEqual([day['date'] for day in payload['days']], [
            f'2026-09-{day:02d}' for day in range(7, 14)
        ])
        snapshot_day = payload['days'][2]
        self.assertEqual(snapshot_day['source'], 'hourly_job')
        self.assertEqual(snapshot_day['job_id'], newest.id)
        self.assertNotEqual(snapshot_day['job_id'], older.id)
        self.assertEqual(set(snapshot_day['briefing']), {'facts', 'severity', 'top_risks', 'warnings', 'data_freshness'})
        self.assertEqual(snapshot_day['briefing']['facts']['injection']['actual_qty'], 1234)
        self.assertNotIn('answer', snapshot_day['briefing'])
        for other_day in (payload['days'][0], payload['days'][3]):
            self.assertEqual(other_day['source'], 'briefing')
            self.assertIn('facts', other_day['briefing'])
            self.assertIn('severity', other_day['briefing'])
        for key in ('completion_rate', 'time_progress', 'behind_rule'):
            self.assertIn(key, payload['metric_definitions'])
        self.assertTrue(payload['constraints'])
        for token in ('1234', '2000', '61.7', '321', '850'):
            self.assertIn(token, payload['evidence_numbers'])
        self.assertEqual(payload['excluded_dates'], [])

    def test_quality_weekly_reduces_daily_attention_to_counts_and_shares(self):
        ProductionPlan.objects.create(
            plan_date=date(2026, 9, 9),
            plan_type='injection',
            machine_name='1호기',
            model_name='MODEL-A',
            part_no='ABC123456-X',
            lot_no='LOT-1',
            planned_quantity=500,
            sequence=1,
        )
        for index, phenomenon in enumerate(['白化', '白化', '黑点']):
            QualityReport.objects.create(
                report_dt=shanghai(2026, 9, 1 + index, 9, 0),
                section='LQC_INJ',
                model='MODEL-A',
                part_no='ABC123456-HISTORY',
                judgement='NG',
                phenomenon=phenomenon,
            )

        payload = build_deep_analysis_input('quality_weekly', 'zh', date(2026, 9, 7), date(2026, 9, 13))

        self.assertEqual(payload['kind'], 'quality_weekly')
        self.assertEqual(payload['language'], 'zh')
        self.assertEqual(payload['period']['basis'], 'calendar_day_00_to_00')
        included = [day for day in payload['days'] if day['included']]
        self.assertEqual([day['date'] for day in included], ['2026-09-09'])
        day = included[0]
        self.assertEqual(day['plan_group_count'], 1)
        self.assertEqual(day['matched_report_count'], 3)
        self.assertTrue(day['problem_types'])
        top = day['problem_types'][0]
        self.assertEqual(top['evidence_count'], 2)
        self.assertEqual(top['share_pct'], 66.7)
        self.assertEqual(top['repeat_status'], 'repeated')
        self.assertIn('status', top['trend'])
        self.assertEqual(set(top), {
            'metric_key', 'label', 'evidence_count', 'share_pct', 'repeat_status',
            'latest_report_dt', 'trend',
        })
        self.assertEqual(day['plan_items'][0]['planned_quantity'], 500)
        self.assertEqual(len(payload['excluded_dates']), 6)
        self.assertTrue(all(row['reason'] == 'no_injection_plan' for row in payload['excluded_dates']))
        self.assertIn('excluded_dates', payload['metric_definitions'])
        for token in ('3', '2', '66.7', '500'):
            self.assertIn(token, payload['evidence_numbers'])
        # Report ids and raw text never enter the pack.
        self.assertNotIn('reports', day)
        self.assertNotIn('phenomenon', str(day['problem_types']))

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(ValueError):
            build_deep_analysis_input('production_daily', 'ko', date(2026, 9, 7), date(2026, 9, 13))


class DeepAnalysisResultContractTests(TestCase):
    def make_job(self, evidence_numbers=('1234', '61.7', '61', '2026', '09', '13')):
        return AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_RUNNING,
            scope=deep_scope(),
            input_payload={
                'schema_version': DEEP_ANALYSIS_INPUT_SCHEMA_VERSION,
                'kind': 'production_weekly',
                'language': 'ko',
                'period': {'start': '2026-09-07', 'end': '2026-09-13', 'day_count': 7},
                'evidence_numbers': list(evidence_numbers),
            },
        )

    def worker_result(self, **overrides):
        result = {
            'schema_version': DEEP_ANALYSIS_RESULT_SCHEMA_VERSION,
            'source': DEEP_ANALYSIS_RESULT_SOURCE,
            'model_id': 'claude',
            'summary': '주간 사출 실적 1,234개, 완료율 61.7%로 마감했습니다.',
            'findings': [{
                'title': '완료율 61%대',
                'statement': '2026-09-13 완료율 61.7%.',
                'evidence_refs': ['2026-09-13:injection.completion_rate'],
            }],
            'actions': ['형합 데이터 갱신 지연 원인을 확인하세요.'],
            'caveats': ['추정치입니다.'],
            'llm_fallback': False,
            'kind': 'tampered',
            'period': {'start': 'tampered'},
        }
        result.update(overrides)
        return result

    def test_grounded_result_is_accepted_and_identity_is_server_owned(self):
        job = self.make_job()
        result = restore_authoritative_deep_analysis_result(job, self.worker_result())

        self.assertFalse(result['llm_fallback'])
        self.assertIsNone(result['llm_fallback_code'])
        self.assertEqual(result['summary'], '주간 사출 실적 1,234개, 완료율 61.7%로 마감했습니다.')
        self.assertEqual(len(result['findings']), 1)
        self.assertEqual(result['findings'][0]['evidence_refs'], ['2026-09-13:injection.completion_rate'])
        self.assertEqual(result['kind'], 'production_weekly')
        self.assertEqual(result['language'], 'ko')
        self.assertEqual(result['period']['start'], '2026-09-07')
        self.assertEqual(result['period']['end'], '2026-09-13')
        self.assertEqual(result['model_id'], 'claude')
        self.assertEqual(result['source'], DEEP_ANALYSIS_RESULT_SOURCE)
        self.assertEqual(result['grounding']['ungrounded_numbers'], [])
        self.assertNotIn('llm_review_summary', result)

    def test_ungrounded_number_keeps_draft_under_review_fields(self):
        job = self.make_job()
        result = restore_authoritative_deep_analysis_result(
            job,
            self.worker_result(actions=['불량률을 5% 줄이세요.']),
        )

        self.assertTrue(result['llm_fallback'])
        self.assertEqual(result['llm_fallback_code'], 'grounding_rejected')
        self.assertEqual(result['grounding']['ungrounded_numbers'], ['5'])
        self.assertEqual(result['summary'], '')
        self.assertEqual(result['findings'], [])
        self.assertEqual(result['actions'], [])
        self.assertEqual(result['llm_review_summary'], '주간 사출 실적 1,234개, 완료율 61.7%로 마감했습니다.')
        self.assertEqual(result['llm_review_actions'], ['불량률을 5% 줄이세요.'])
        self.assertEqual(len(result['llm_review_findings']), 1)
        self.assertEqual(result['kind'], 'production_weekly')

    def test_evidence_refs_are_grounded_like_prose(self):
        job = self.make_job()
        result = restore_authoritative_deep_analysis_result(
            job,
            self.worker_result(findings=[{
                'title': '완료율',
                'statement': '2026-09-13 완료율 61.7%.',
                'evidence_refs': ['2026-09-13:injection.completion_rate=71.2'],
            }]),
        )
        self.assertEqual(result['llm_fallback_code'], 'grounding_rejected')
        self.assertEqual(result['grounding']['ungrounded_numbers'], ['71.2'])

    def test_natural_date_prose_is_grounded_by_canonical_tokens(self):
        job = self.make_job()
        result = restore_authoritative_deep_analysis_result(
            job,
            self.worker_result(summary='9월 13일 완료율 61.70%, 실적 1234개.'),
        )
        self.assertFalse(result['llm_fallback'])
        self.assertEqual(result['grounding']['ungrounded_numbers'], [])

    def test_schema_mismatch_and_caps(self):
        job = self.make_job()
        rejected = restore_authoritative_deep_analysis_result(
            job,
            self.worker_result(source='local_llm_rewrite'),
        )
        self.assertTrue(rejected['llm_fallback'])
        self.assertEqual(rejected['llm_fallback_code'], 'schema_rejected')

        worker_fallback = restore_authoritative_deep_analysis_result(
            job,
            self.worker_result(llm_fallback=True, llm_fallback_code='input_too_large'),
        )
        self.assertTrue(worker_fallback['llm_fallback'])
        self.assertEqual(worker_fallback['llm_fallback_code'], 'input_too_large')

        capped = restore_authoritative_deep_analysis_result(
            job,
            self.worker_result(
                summary='가' * 2000,
                findings=[{'title': f'항목 {"가" * 5}', 'statement': '검증된 사실', 'evidence_refs': []}] * 12,
                actions=['조치'] * 12,
                caveats=['주의'] * 9,
            ),
        )
        self.assertFalse(capped['llm_fallback'])
        self.assertEqual(len(capped['summary']), 1200)
        self.assertEqual(len(capped['findings']), 8)
        self.assertEqual(len(capped['actions']), 8)
        self.assertEqual(len(capped['caveats']), 6)


@override_settings(AI_WORKER_TOKEN='test-worker-token')
class DeepAnalysisApiTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.user = get_user_model().objects.create_user(username='deep-user', password='test-pass')
        self.staff = get_user_model().objects.create_user(
            username='deep-staff', password='test-pass', is_staff=True,
        )

    def claim(self, worker_name, model_ids, job_types=None, limit=1):
        self.client.force_authenticate(user=None)
        body = {
            'worker_name': worker_name,
            'worker_version': 'production-ai-worker-v2',
            'limit': limit,
            'available_model_ids': model_ids,
        }
        if job_types is not None:
            body['job_types'] = job_types
        return self.client.post('/api/ai/jobs/claim/', body, format='json', **WORKER_HEADERS)

    def test_manual_deep_analysis_is_staff_only_and_rate_limited(self):
        self.client.force_authenticate(self.user)
        denied = self.client.post('/api/ai/jobs/', {
            'job_type': AiJob.JOB_TYPE_DEEP_ANALYSIS,
            'scope': {'kind': 'production_weekly', 'language': 'ko', 'date': '2026-09-13'},
        }, format='json')
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(AiJob.objects.count(), 0)

        self.client.force_authenticate(self.staff)
        bad_kind = self.client.post('/api/ai/jobs/', {
            'job_type': AiJob.JOB_TYPE_DEEP_ANALYSIS,
            'scope': {'kind': 'production_daily', 'language': 'ko'},
        }, format='json')
        self.assertEqual(bad_kind.status_code, 400)

        with mock.patch(
            'ai_core.views.build_deep_analysis_input',
            return_value={'schema_version': DEEP_ANALYSIS_INPUT_SCHEMA_VERSION, 'evidence_numbers': []},
        ) as build_input:
            created = self.client.post('/api/ai/jobs/', {
                'job_type': AiJob.JOB_TYPE_DEEP_ANALYSIS,
                'scope': {'kind': 'quality_weekly', 'language': 'zh', 'date': '2026-09-13'},
                'input_payload': {'evidence_numbers': ['999']},
            }, format='json')
            self.assertEqual(created.status_code, 201, created.data)
            build_input.assert_called_once_with('quality_weekly', 'zh', date(2026, 9, 7), date(2026, 9, 13))
            second = self.client.post('/api/ai/jobs/', {
                'job_type': AiJob.JOB_TYPE_DEEP_ANALYSIS,
                'scope': {'kind': 'production_weekly', 'language': 'ko'},
            }, format='json')

        self.assertEqual(created.data['scope'], {
            'kind': 'quality_weekly',
            'language': 'zh',
            'period_start': '2026-09-07',
            'period_end': '2026-09-13',
            'trigger': 'manual',
            'model_id': 'claude',
        })
        self.assertEqual(created.data['model_display_name'], 'Claude')
        self.assertEqual(created.data['input_payload']['evidence_numbers'], [])
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.data['code'], 'manual_ai_job_rate_limited')

    def test_manual_deep_analysis_date_defaults_to_current_business_date(self):
        self.client.force_authenticate(self.staff)
        with mock.patch('ai_core.views.build_deep_analysis_input', return_value={}), \
                mock.patch('ai_core.views.current_business_scope', return_value=(date(2026, 9, 18), 'slot')):
            created = self.client.post('/api/ai/jobs/', {
                'job_type': AiJob.JOB_TYPE_DEEP_ANALYSIS,
                'scope': {'kind': 'production_weekly', 'language': 'ko'},
            }, format='json')
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data['scope']['period_start'], '2026-09-12')
        self.assertEqual(created.data['scope']['period_end'], '2026-09-18')

    def test_claim_routes_deep_jobs_by_advertised_claude_capability(self):
        deep_job = AiJob.objects.create(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS, scope=deep_scope())
        hourly_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={'date': '2026-09-13', 'language': 'ko', 'trigger': 'hourly', 'model_id': 'qwen38'},
        )

        local_default = self.claim('mac-studio-local-ai', ['qwen38'], limit=10)
        self.assertEqual([job['id'] for job in local_default.data['jobs']], [hourly_job.id])

        AiJob.objects.filter(pk=hourly_job.pk).update(status=AiJob.STATUS_PENDING, claimed_by='', claimed_at=None)
        deep_only = self.claim('mac-studio-claude-desktop', ['claude'], job_types=['deep_analysis'], limit=10)
        self.assertEqual([job['id'] for job in deep_only.data['jobs']], [deep_job.id])
        self.assertEqual(deep_only.data['jobs'][0]['status'], AiJob.STATUS_CLAIMED)
        self.assertEqual(deep_only.data['jobs'][0]['model_display_name'], 'Claude')
        hourly_job.refresh_from_db()
        self.assertEqual(hourly_job.status, AiJob.STATUS_PENDING)

        AiJob.objects.filter(pk=deep_job.pk).update(status=AiJob.STATUS_PENDING, claimed_by='', claimed_at=None)
        deep_without_capability = self.claim('mac-studio-claude-desktop', ['qwen38'], job_types=['deep_analysis'])
        self.assertEqual(deep_without_capability.data['jobs'], [])

    def test_deep_jobs_keep_their_lease_past_the_local_worker_timeout(self):
        deep_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_RUNNING,
            scope=deep_scope(),
            claimed_by='mac-studio-claude-desktop',
            claimed_at=timezone.now(),
        )
        local_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_RUNNING,
            scope={'date': '2026-09-13', 'language': 'ko', 'trigger': 'hourly', 'model_id': 'qwen38'},
            claimed_by='mac-studio-local-ai',
            claimed_at=timezone.now(),
        )
        # 20 minutes of silence: the local job is re-queued, the deep job is not.
        AiJob.objects.filter(pk__in=[deep_job.pk, local_job.pk]).update(updated_at=timezone.now() - timedelta(minutes=20))
        self.claim('mac-studio-local-ai', ['qwen38'], limit=10)
        deep_job.refresh_from_db()
        local_job.refresh_from_db()
        self.assertEqual(deep_job.status, AiJob.STATUS_RUNNING)
        self.assertEqual(deep_job.claimed_by, 'mac-studio-claude-desktop')
        self.assertEqual(local_job.status, AiJob.STATUS_CLAIMED)  # re-queued and claimed again

        # Past the deep-tier timeout it is re-queued like any other job.
        AiJob.objects.filter(pk=deep_job.pk).update(
            updated_at=timezone.now() - timedelta(seconds=DEEP_ANALYSIS_JOB_TIMEOUT_SECONDS + 60),
        )
        self.claim('mac-studio-local-ai', ['qwen38'], limit=10)
        deep_job.refresh_from_db()
        self.assertEqual(deep_job.status, AiJob.STATUS_PENDING)
        self.assertEqual(deep_job.claimed_by, '')

    def test_claim_priority_order_is_daily_question_hourly_manual_deep_audit(self):
        local_today = timezone.now().astimezone(SHANGHAI_TZ).date().isoformat()
        created_in_reverse_priority = [
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                scope={'mode': QUALITY_REPORT_AUDIT_MODE, 'trigger': QUALITY_REPORT_AUDIT_TRIGGER, 'report_id': 1, 'model_id': 'qwen38'},
            ),
            AiJob.objects.create(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS, scope=deep_scope()),
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
                scope={'date': '2026-09-13', 'language': 'ko', 'trigger': 'manual', 'model_id': 'qwen38'},
                created_by=self.user,
            ),
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
                scope={'date': '2026-09-13', 'language': 'ko', 'trigger': 'hourly', 'model_id': 'qwen38'},
            ),
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
                scope={'date': '2026-09-13', 'language': 'ko', 'trigger': 'question', 'model_id': 'qwen38'},
                created_by=self.user,
            ),
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                scope={'mode': QUALITY_DAILY_MODE, 'trigger': QUALITY_DAILY_TRIGGER, 'date': '2026-09-01', 'model_id': 'qwen38'},
            ),
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_QUALITY_IMAGE,
                scope={'mode': QUALITY_DAILY_MODE, 'trigger': QUALITY_DAILY_TRIGGER, 'date': local_today, 'model_id': 'qwen38'},
            ),
        ]
        expected_order = [job.id for job in reversed(created_in_reverse_priority)]

        claimed = []
        for _ in range(len(expected_order) + 1):
            response = self.claim('dual-tier-worker', ['qwen38', 'claude'], limit=1)
            self.assertEqual(response.status_code, 200)
            claimed.extend(job['id'] for job in response.data['jobs'])
        self.assertEqual(claimed, expected_order)

    def complete(self, job, result_payload, model_name='/Users/x/claude-desktop'):
        job.status = AiJob.STATUS_RUNNING
        job.claimed_by = 'mac-studio-claude-desktop'
        job.claimed_at = timezone.now()
        job.save(update_fields=['status', 'claimed_by', 'claimed_at', 'updated_at'])
        self.client.force_authenticate(user=None)
        return self.client.post(
            f'/api/ai/jobs/{job.pk}/complete/',
            {
                'result_payload': result_payload,
                'model_name': model_name,
                'prompt_version': 'deep-analysis-v1',
                'worker_name': job.claimed_by,
                'claim_timestamp': job.claimed_at.isoformat(),
            },
            format='json',
            **WORKER_HEADERS,
        )

    def test_complete_validates_grounding_and_stores_display_model_name(self):
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            scope=deep_scope(),
            input_payload={
                'schema_version': DEEP_ANALYSIS_INPUT_SCHEMA_VERSION,
                'kind': 'production_weekly',
                'language': 'ko',
                'period': {'start': '2026-09-07', 'end': '2026-09-13'},
                'evidence_numbers': ['61.7', '2026', '09', '13'],
            },
        )
        accepted = self.complete(job, {
            'schema_version': DEEP_ANALYSIS_RESULT_SCHEMA_VERSION,
            'source': DEEP_ANALYSIS_RESULT_SOURCE,
            'model_id': 'claude',
            'summary': '완료율 61.7%로 마감.',
            'findings': [],
            'actions': [],
            'caveats': [],
            'llm_fallback': False,
        })
        self.assertEqual(accepted.status_code, 200, accepted.data)
        self.assertEqual(accepted.data['result_payload']['summary'], '완료율 61.7%로 마감.')
        self.assertFalse(accepted.data['result_payload']['llm_fallback'])
        self.assertEqual(accepted.data['result_payload']['model_id'], 'claude')
        self.assertEqual(accepted.data['model_name'], 'claude-desktop')
        self.assertEqual(accepted.data['model_display_name'], 'Claude')

        rejected_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            scope=deep_scope(language='zh'),
            input_payload={'kind': 'production_weekly', 'language': 'zh', 'evidence_numbers': ['61.7']},
        )
        rejected = self.complete(rejected_job, {
            'schema_version': DEEP_ANALYSIS_RESULT_SCHEMA_VERSION,
            'source': DEEP_ANALYSIS_RESULT_SOURCE,
            'model_id': 'claude',
            'summary': '完成率 61.7%，比上周高 4 个百分点。',
            'findings': [],
            'actions': [],
            'caveats': [],
            'llm_fallback': False,
        })
        self.assertEqual(rejected.status_code, 200, rejected.data)
        payload = rejected.data['result_payload']
        self.assertTrue(payload['llm_fallback'])
        self.assertEqual(payload['llm_fallback_code'], 'grounding_rejected')
        self.assertEqual(payload['summary'], '')
        self.assertEqual(payload['llm_review_summary'], '完成率 61.7%，比上周高 4 个百分点。')
        self.assertEqual(payload['language'], 'zh')

    def test_fail_stores_display_model_name(self):
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_RUNNING,
            scope={'date': '2026-09-13', 'language': 'ko', 'trigger': 'hourly', 'model_id': 'qwen38'},
            claimed_by='mac-studio-local-ai',
            claimed_at=timezone.now(),
        )
        self.client.force_authenticate(user=None)
        response = self.client.post(
            f'/api/ai/jobs/{job.pk}/fail/',
            {
                'error_message': 'AI model timed out',
                'model_name': '/private/models/Qwen3.8-27B-4bit',
                'worker_name': job.claimed_by,
                'claim_timestamp': job.claimed_at.isoformat(),
            },
            format='json',
            **WORKER_HEADERS,
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['model_name'], 'Qwen3.8-27B-4bit')
        self.assertEqual(response.data['model_display_name'], 'Qwen 3.8 27B')

    def test_latest_returns_newest_completed_deep_analysis_and_pending_job(self):
        older = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_COMPLETED,
            scope=deep_scope(period_end=date(2026, 9, 6)),
            result_payload={'summary': 'older'},
            completed_at=timezone.now() - timedelta(days=7),
        )
        newest = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_COMPLETED,
            scope=deep_scope(trigger='manual'),
            result_payload={'summary': 'newest'},
            model_name='claude-desktop',
            completed_at=timezone.now() - timedelta(hours=1),
            created_by=self.staff,
        )
        AiJob.objects.create(  # other language
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_COMPLETED,
            scope=deep_scope(language='zh'),
            result_payload={'summary': 'zh'},
            completed_at=timezone.now(),
        )
        AiJob.objects.create(  # other kind
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_COMPLETED,
            scope=deep_scope(kind='quality_weekly'),
            result_payload={'summary': 'quality'},
            completed_at=timezone.now(),
        )
        pending = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            scope=deep_scope(period_end=date(2026, 9, 20)),
        )

        self.client.force_authenticate(self.user)  # not the creator, not staff
        response = self.client.get('/api/ai/jobs/latest/', {
            'job_type': 'deep_analysis',
            'kind': 'production_weekly',
            'language': 'ko',
        })
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['job']['id'], newest.id)
        self.assertNotEqual(response.data['job']['id'], older.id)
        self.assertEqual(response.data['job']['model_display_name'], 'Claude')
        self.assertNotIn('input_payload', response.data['job'])
        self.assertEqual(response.data['pending_job']['id'], pending.id)
        self.assertIsNone(response.data['failed_job'])

        # A failure newer than the completed result is surfaced; an older one is not.
        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS,
            status=AiJob.STATUS_FAILED,
            scope=deep_scope(period_end=date(2026, 9, 6)),
            error_message='old failure',
        )
        with_failure = self.client.get('/api/ai/jobs/latest/', {
            'job_type': 'deep_analysis', 'kind': 'production_weekly', 'language': 'ko',
        })
        self.assertEqual(with_failure.data['failed_job']['error_message'], 'old failure')
        self.assertEqual(with_failure.data['job']['id'], newest.id)

        explicit_model = self.client.get('/api/ai/jobs/latest/', {
            'job_type': 'deep_analysis', 'kind': 'production_weekly', 'language': 'ko', 'model_id': 'claude',
        })
        self.assertEqual(explicit_model.data['job']['id'], newest.id)
        missing_kind = self.client.get('/api/ai/jobs/latest/', {'job_type': 'deep_analysis'})
        self.assertEqual(missing_kind.status_code, 400)
        bad_model = self.client.get('/api/ai/jobs/latest/', {
            'job_type': 'deep_analysis', 'kind': 'production_weekly', 'model_id': 'gpt',
        })
        self.assertEqual(bad_model.status_code, 400)

    def test_heartbeat_accepts_claude_capability(self):
        self.client.force_authenticate(user=None)
        response = self.client.post(
            '/api/ai/worker/heartbeat/',
            {
                'worker_name': 'mac-studio-claude-desktop',
                'llm_enabled': True,
                'llm_ready': True,
                'model_name': 'claude-desktop',
                'worker_version': 'production-ai-worker-v2',
                'available_model_ids': ['claude'],
            },
            format='json',
            **WORKER_HEADERS,
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['available_model_ids'], ['claude'])

    def test_status_describes_local_tier_at_top_level_and_lists_both_workers(self):
        create_heartbeat(
            'mac-studio-local-ai', ['qwen38'],
            model_name='/private/models/Qwen3.8-27B-4bit',
            age=timedelta(seconds=40),
        )
        create_heartbeat(
            'mac-studio-claude-desktop', ['claude'],
            model_name='claude-desktop',
            age=timedelta(seconds=5),  # fresher, but not the local tier
        )

        self.client.force_authenticate(self.user)
        response = self.client.get('/api/ai/worker/status/', {'language': 'ko'})

        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['worker_name'], 'mac-studio-local-ai')
        self.assertEqual(response.data['tier'], 'local')
        self.assertEqual(response.data['state'], 'online')
        self.assertEqual(response.data['model_name'], 'Qwen3.8-27B-4bit')
        self.assertEqual(response.data['model_display_name'], 'Qwen 3.8 27B')
        self.assertEqual(response.data['available_model_ids'], ['qwen38'])
        self.assertTrue(response.data['worker_compatible'])
        self.assertTrue(response.data['llm_ready'])
        workers = {worker['worker_name']: worker for worker in response.data['workers']}
        self.assertEqual(set(workers), {'mac-studio-local-ai', 'mac-studio-claude-desktop'})
        self.assertEqual(workers['mac-studio-local-ai']['tier'], 'local')
        self.assertEqual(workers['mac-studio-claude-desktop']['tier'], 'deep')
        self.assertEqual(workers['mac-studio-claude-desktop']['model_display_name'], 'Claude')
        self.assertEqual(workers['mac-studio-claude-desktop']['available_model_ids'], ['claude'])
        self.assertEqual(workers['mac-studio-claude-desktop']['state'], 'online')
        for worker in workers.values():
            for key in ('state', 'online', 'model_name', 'last_heartbeat_at', 'heartbeat_age_seconds',
                        'worker_version', 'worker_compatible', 'llm_ready'):
                self.assertIn(key, worker)

    def test_status_falls_back_to_freshest_local_tier_worker_and_marks_stale_deep_worker(self):
        create_heartbeat('legacy-local', [], model_name='Local-7B', age=timedelta(seconds=30))
        create_heartbeat(
            'mac-studio-claude-desktop', ['claude'],
            model_name='claude-desktop',
            age=timedelta(minutes=20),
        )
        self.client.force_authenticate(self.user)
        response = self.client.get('/api/ai/worker/status/')
        self.assertEqual(response.data['worker_name'], 'legacy-local')
        self.assertEqual(response.data['model_display_name'], 'Local-7B')
        workers = {worker['worker_name']: worker for worker in response.data['workers']}
        self.assertEqual(workers['mac-studio-claude-desktop']['state'], 'offline')
        self.assertFalse(workers['mac-studio-claude-desktop']['online'])

    def test_status_without_heartbeat_reports_registry_display_name(self):
        self.client.force_authenticate(self.user)
        response = self.client.get('/api/ai/worker/status/')
        self.assertEqual(response.data['state'], 'unknown')
        self.assertEqual(response.data['model_display_name'], 'Qwen 3.8 27B')
        self.assertEqual(response.data['workers'], [])

    def test_production_model_availability_considers_every_fresh_heartbeat(self):
        create_heartbeat('mac-studio-local-ai', ['qwen38'], model_name='Qwen3.8-27B-4bit', age=timedelta(seconds=60))
        create_heartbeat('mac-studio-claude-desktop', ['claude'], model_name='claude-desktop', age=timedelta(seconds=1))

        self.assertTrue(is_production_ai_model_available('qwen38'))
        self.assertTrue(is_production_ai_model_available('claude'))
        self.assertFalse(is_production_ai_model_available('gpt'))

        AiJob.objects.filter(scope__worker_name='mac-studio-local-ai').update(
            completed_at=timezone.now() - timedelta(minutes=10),
        )
        self.assertFalse(is_production_ai_model_available('qwen38'))
        self.assertTrue(is_production_ai_model_available('claude'))

    def test_periodic_enqueue_creates_weekly_deep_jobs_when_due(self):
        with mock.patch('ai_core.deep_analysis.build_deep_analysis_input', return_value={'evidence_numbers': []}), \
                mock.patch('ai_core.views.timezone.now', return_value=shanghai(2026, 9, 14, 8, 30)):
            self.client.force_authenticate(user=None)
            response = self.client.post(
                '/api/ai/jobs/enqueue-periodic/',
                {'languages': ['ko']},
                format='json',
                **WORKER_HEADERS,
            )
        self.assertEqual(response.status_code, 200, response.data)
        deep = response.data['deep_analysis']
        self.assertTrue(deep['due'])
        self.assertEqual(deep['created_count'], 1)
        self.assertEqual(deep['period_end'], '2026-09-13')
        deep_jobs = AiJob.objects.filter(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS)
        self.assertEqual(deep_jobs.count(), 1)
        self.assertEqual(deep_jobs.get().scope['language'], 'ko')
        self.assertEqual(response.data['created_count'], 1 + 1)  # one hourly ko + one deep

    def test_periodic_enqueue_survives_a_failing_weekly_pack_build(self):
        with mock.patch('ai_core.deep_analysis.build_deep_analysis_input', side_effect=RuntimeError('mes down')), \
                mock.patch('ai_core.views.timezone.now', return_value=shanghai(2026, 9, 14, 8, 30)), \
                self.assertLogs('ai_core.views', level='ERROR'):
            self.client.force_authenticate(user=None)
            response = self.client.post(
                '/api/ai/jobs/enqueue-periodic/',
                {'languages': ['ko']},
                format='json',
                **WORKER_HEADERS,
            )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIn('RuntimeError: mes down', response.data['deep_analysis']['error'])
        self.assertEqual(response.data['created_count'], 1)  # the hourly job was still created
        self.assertEqual(AiJob.objects.filter(job_type=AiJob.JOB_TYPE_DEEP_ANALYSIS).count(), 0)
