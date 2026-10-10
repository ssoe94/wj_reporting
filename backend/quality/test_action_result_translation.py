from datetime import datetime, timedelta
from unittest.mock import patch
from unittest import skipUnless
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from ai_core.model_registry import SUPPORTED_AI_WORKER_VERSION
from ai_core.models import AiJob
from .action_result_translation import (
    PROMPT_VERSION, SCHEMA_VERSION, accept_translation, enqueue_missing_translations,
    enqueue_report_translation, next_daily_retry, record_translation_failure,
    source_sha256, translation_representation, validate_candidate,
)
from .models import QualityActionResultTranslation, QualityReport
from .serializers import QualityReportSerializer


@override_settings(AI_WORKER_TOKEN='translation-test-token')
class ActionResultTranslationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user('translator-reader', is_active=True, is_staff=True, is_superuser=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.report = QualityReport.objects.create(report_dt=timezone.now(), section='LQC_INJ',
                                                  action_result='CS确认不良4ea 返工')

    def enqueue(self):
        return enqueue_report_translation(self.report.pk)[0]

    def candidate(self, job, text='CS 확인 불량4ea, 재작업'):
        return {'schema_version': SCHEMA_VERSION, 'source': 'local_qwen38_translation', 'language': 'ko',
                'source_sha256': job.scope['source_sha256'], 'translation': text, 'llm_fallback': False}

    def accept(self, job, text='CS 확인 불량4ea, 재작업'):
        return accept_translation(job, self.candidate(job, text), prompt_version=PROMPT_VERSION, model_name='Qwen3.8-27B-4bit')

    def test_source_is_unchanged_when_translation_is_published(self):
        source = self.report.action_result
        job = self.enqueue()
        result = self.accept(job)
        self.report.refresh_from_db()
        self.assertTrue(result['accepted_translation'])
        self.assertEqual(self.report.action_result, source)
        rendered = QualityReportSerializer(self.report).data
        self.assertEqual(rendered['action_result'], source)
        self.assertEqual(rendered['action_result_translation']['text'], 'CS 확인 불량4ea, 재작업')
        self.assertEqual(rendered['action_result_translation']['status'], 'translated')

    def test_enqueue_deduplicates_active_and_successful_source(self):
        job = self.enqueue()
        again, created = enqueue_report_translation(self.report.pk)
        self.assertFalse(created)
        self.assertEqual(again.pk, job.pk)
        self.accept(job)
        self.assertFalse(enqueue_report_translation(self.report.pk)[1])
        self.assertEqual(AiJob.objects.filter(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).count(), 1)

    def test_source_edit_hides_old_translation_and_rejects_in_flight_result(self):
        job = self.enqueue()
        self.accept(job)
        QualityReport.objects.filter(pk=self.report.pk).update(action_result='CS确认不良5ea 返工')
        self.report.refresh_from_db()
        self.assertEqual(translation_representation(self.report)['text'], '')
        self.assertFalse(self.accept(job)['accepted_translation'])
        current, created = enqueue_report_translation(self.report.pk)
        self.assertTrue(created)
        self.assertNotEqual(current.pk, job.pk)
        self.assertTrue(self.accept(current, 'CS 확인 불량5ea, 재작업')['accepted_translation'])

    def test_failed_translation_waits_until_next_six_am(self):
        job = self.enqueue()
        moment = datetime(2026, 10, 10, 15, tzinfo=ZoneInfo('Asia/Shanghai'))
        with patch('quality.action_result_translation.timezone.now', return_value=moment):
            job.status = AiJob.STATUS_FAILED
            job.save(update_fields=['status'])
            record_translation_failure(job)
            self.assertFalse(enqueue_report_translation(self.report.pk, retry=True)[1])
        cached = QualityActionResultTranslation.objects.get(report=self.report)
        self.assertEqual(cached.retry_after.astimezone(ZoneInfo('Asia/Shanghai')).hour, 6)
        with patch('quality.action_result_translation.timezone.now', return_value=moment + timedelta(days=1)):
            self.assertTrue(enqueue_report_translation(self.report.pk, retry=True)[1])

    def test_six_am_boundary_and_offline_catch_up(self):
        before = datetime(2026, 10, 10, 5, 59, tzinfo=ZoneInfo('Asia/Shanghai'))
        at = before + timedelta(minutes=1)
        self.assertEqual(enqueue_missing_translations(before)['created_count'], 0)
        self.assertEqual(enqueue_missing_translations(at)['created_count'], 1)
        self.assertEqual(enqueue_missing_translations(at + timedelta(hours=4))['created_count'], 0)
        self.assertEqual(next_daily_retry(before), at)

    def test_no_queue_for_empty_or_korean_only_source(self):
        for text in ('', '불량품 폐기 처리'):
            self.report.action_result = text
            self.report.save(update_fields=['action_result'])
            self.assertFalse(enqueue_report_translation(self.report.pk)[1])
            self.assertEqual(translation_representation(self.report)['status'], 'not_required')

    def test_new_registration_enqueues_and_rollback_does_not(self):
        from django.db import transaction
        with self.captureOnCommitCallbacks(execute=True):
            new_report = QualityReport.objects.create(report_dt=timezone.now(), action_result='报废处理')
        self.assertEqual(QualityActionResultTranslation.objects.get(report=new_report).job.input_payload['source_text'], '报废处理')
        count = AiJob.objects.filter(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).count()
        with self.captureOnCommitCallbacks(execute=True):
            try:
                with transaction.atomic():
                    QualityReport.objects.create(report_dt=timezone.now(), action_result='返工')
                    raise RuntimeError('rollback source entry')
            except RuntimeError:
                pass
        self.assertEqual(AiJob.objects.filter(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).count(), count)

    def test_changed_source_from_bulk_update_is_repaired_by_daily_scan(self):
        job = self.enqueue()
        self.accept(job)
        QualityReport.objects.filter(pk=self.report.pk).update(action_result='CS确认不良5ea 返工')
        at = datetime(2026, 10, 10, 9, tzinfo=ZoneInfo('Asia/Shanghai'))
        self.assertEqual(enqueue_missing_translations(at)['created_count'], 1)
        latest = QualityActionResultTranslation.objects.get(report=self.report)
        self.assertEqual(latest.job.input_payload['source_text'], 'CS确认不良5ea 返工')

    def test_registration_and_edit_enqueue_only_after_commit(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            self.report.action_result = '报废处理'
            self.report.save(update_fields=['action_result'])
            self.assertFalse(AiJob.objects.filter(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).exists())
        self.assertEqual(len(callbacks), 1)
        self.assertEqual(AiJob.objects.get(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).input_payload['source_text'], '报废处理')
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            self.report.model = 'new-model'
            self.report.save(update_fields=['model'])
        self.assertEqual(callbacks, [])

    def test_read_does_not_seed_translation_or_jobs(self):
        self.assertEqual(self.client.get('/api/quality/reports/').status_code, 200)
        self.assertFalse(QualityActionResultTranslation.objects.exists())
        self.assertFalse(AiJob.objects.filter(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).exists())

    def test_translation_is_read_only_and_original_patch_still_works(self):
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch(f'/api/quality/reports/{self.report.pk}/',
                                        {'action_result': '报废处理', 'action_result_translation': {'text': '악성 덮어쓰기'}}, format='json')
        self.assertEqual(response.status_code, 200)
        self.report.refresh_from_db()
        self.assertEqual(self.report.action_result, '报废处理')
        self.assertEqual(QualityActionResultTranslation.objects.get(report=self.report).text, '')

    def test_numbers_company_names_and_completion_status_are_guarded(self):
        invalid = [('不良4ea 返工', '불량5ea 재작업'), ('厂家：紫金 退货', '업체: 자금 반품'),
                   ('返工', '재작업 완료'), ('不良5ea', '불량5ea 2건'), ('CS返工', '재작업'),
                   ('误差-5mm', '오차5mm'), ('不良率10%', '불량률10'),
                   ('返工 报废', '재작업'), ('擦拭', '세척')]
        from rest_framework.exceptions import ValidationError
        for source, text in invalid:
            with self.subTest(source=source), self.assertRaises(ValidationError):
                validate_candidate(source, text)

    def test_superseded_job_cannot_publish_even_with_identical_source(self):
        job = self.enqueue()
        QualityActionResultTranslation.objects.filter(report=self.report).update(job=None)
        self.assertFalse(self.accept(job)['accepted_translation'])

    def test_worker_claim_complete_and_untrusted_result_validation(self):
        job = self.enqueue()
        worker = APIClient()
        worker.credentials(HTTP_X_AI_WORKER_TOKEN='translation-test-token')
        response = worker.post('/api/ai/jobs/claim/', {'worker_name': 'translation-worker', 'worker_version': SUPPORTED_AI_WORKER_VERSION,
                              'available_model_ids': ['qwen38'], 'job_types': [AiJob.JOB_TYPE_QUALITY_TRANSLATION]}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        claimed = response.data['jobs'][0]
        body = {'worker_name': 'translation-worker', 'claim_timestamp': claimed['claimed_at'],
                'result_payload': self.candidate(job, 'CS 확인 불량5ea 재작업'), 'prompt_version': PROMPT_VERSION, 'model_name': 'Qwen3.8-27B-4bit'}
        self.assertEqual(worker.post(f'/api/ai/jobs/{job.pk}/complete/', body, format='json').status_code, 400)
        body['result_payload'] = self.candidate(job)
        response = worker.post(f'/api/ai/jobs/{job.pk}/complete/', body, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data['result_payload']['accepted_translation'])
        self.report.refresh_from_db()
        self.assertEqual(self.report.action_result, 'CS确认不良4ea 返工')

    def test_unauthenticated_cannot_read_or_write_translations(self):
        client = APIClient()
        self.assertIn(client.get('/api/quality/reports/').status_code, (401, 403))
        self.assertIn(client.post('/api/ai/jobs/claim/', {}, format='json').status_code, (401, 403))
        response = self.client.post('/api/ai/jobs/', {'job_type': AiJob.JOB_TYPE_QUALITY_TRANSLATION}, format='json')
        self.assertEqual(response.status_code, 400)

    def test_viewer_cannot_modify_source_or_translation(self):
        viewer = get_user_model().objects.create_user('translation-viewer')
        viewer.profile.can_view_quality = True
        viewer.profile.can_edit_quality = False
        viewer.profile.save()
        client = APIClient()
        client.force_authenticate(viewer)
        job = self.enqueue()
        self.accept(job)
        self.assertEqual(client.get('/api/quality/reports/').status_code, 200)
        self.assertEqual(client.patch(f'/api/quality/reports/{self.report.pk}/', {'action_result': '원문 변조'}, format='json').status_code, 403)

    def test_translation_jobs_do_not_expose_quality_notes_through_ai_job_lists(self):
        job = self.enqueue()
        self.accept(job)
        blocked = get_user_model().objects.create_user('no-quality-access')
        blocked.profile.can_view_quality = False
        blocked.profile.save()
        client = APIClient()
        client.force_authenticate(blocked)
        self.assertEqual(client.get('/api/quality/reports/').status_code, 403)
        listing = client.get('/api/ai/jobs/', {'job_type': AiJob.JOB_TYPE_QUALITY_TRANSLATION})
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.data['results'], [])
        self.assertEqual(client.get(f'/api/ai/jobs/{job.pk}/').status_code, 404)

    def test_long_source_is_preserved_instead_of_truncated(self):
        source = '报废' * 3100
        QualityReport.objects.filter(pk=self.report.pk).update(action_result=source)
        self.assertFalse(enqueue_report_translation(self.report.pk)[1])
        self.report.refresh_from_db()
        self.assertEqual(self.report.action_result, source)
        self.assertEqual(translation_representation(self.report)['status'], 'failed')


@skipUnless(connection.vendor == 'postgresql', 'Real row locks require disposable PostgreSQL')
class ActionResultTranslationPostgresTests(TransactionTestCase):
    def test_concurrent_enqueue_has_one_current_job(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        report = QualityReport.objects.create(report_dt=timezone.now(), action_result='报废处理')
        # Model-save already enqueued once; remove only the local fixture's cache/jobs.
        QualityActionResultTranslation.objects.filter(report=report).delete()
        AiJob.objects.filter(job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION).delete()
        ready = Barrier(2)
        def enqueue():
            close_old_connections()
            try:
                ready.wait(timeout=10)
                job, created = enqueue_report_translation(report.pk)
                return job.pk, created
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: enqueue(), range(2)))
        self.assertEqual(len({row[0] for row in results}), 1)
        self.assertEqual(sum(row[1] for row in results), 1)
        self.assertEqual(QualityActionResultTranslation.objects.filter(report=report).count(), 1)

    def test_publication_waits_for_source_edit_and_rejects_old_snapshot(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Event
        report = QualityReport.objects.create(report_dt=timezone.now(), action_result='报废处理')
        job = QualityActionResultTranslation.objects.get(report=report).job
        locked, accept_started = Event(), Event()
        def edit():
            close_old_connections()
            try:
                with transaction.atomic():
                    current = QualityReport.objects.select_for_update().get(pk=report.pk)
                    current.action_result = '返工'
                    current.save(update_fields=['action_result'])
                    locked.set()
                    if not accept_started.wait(timeout=10):
                        raise RuntimeError('Publication did not start')
            finally:
                close_old_connections()
        def publish():
            close_old_connections()
            try:
                if not locked.wait(timeout=10):
                    raise RuntimeError('Source edit did not start')
                with transaction.atomic():
                    current_job = AiJob.objects.select_for_update().get(pk=job.pk)
                    accept_started.set()
                    result = accept_translation(current_job, {'schema_version': SCHEMA_VERSION,
                        'source': 'local_qwen38_translation', 'language': 'ko', 'llm_fallback': False,
                        'source_sha256': source_sha256('报废处理'), 'translation': '폐기 처리'},
                        prompt_version=PROMPT_VERSION, model_name='Qwen3.8-27B-4bit')
                    return result
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            editing = pool.submit(edit)
            publishing = pool.submit(publish)
            editing.result(timeout=20)
            result = publishing.result(timeout=20)
        self.assertFalse(result['accepted_translation'])
        report.refresh_from_db()
        self.assertEqual(report.action_result, '返工')
        self.assertEqual(QualityActionResultTranslation.objects.get(report=report).text, '')
