import os
import sys
import unittest
from datetime import timedelta
from pathlib import Path

import requests
from django.contrib.auth import get_user_model
from django.test import LiveServerTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import AiJob


@override_settings(AI_WORKER_TOKEN='test-worker-token')
class AiJobApiTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='ai-user', password='test-pass')
        self.client.force_authenticate(self.user)

    def test_user_can_create_and_worker_can_complete_job(self):
        create_response = self.client.post('/api/ai/jobs/', {
            'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
            'scope': {'date': '2026-05-15', 'language': 'ko'},
            'input_payload': {'briefing': {'answer': 'untrusted client briefing'}},
        }, format='json')

        self.assertEqual(create_response.status_code, 201)
        job_id = create_response.data['id']
        self.assertEqual(create_response.data['status'], AiJob.STATUS_PENDING)
        self.assertEqual(create_response.data['scope']['trigger'], 'manual')
        self.assertEqual(create_response.data['scope']['model_id'], 'qwen38')
        self.assertEqual(create_response.data['input_payload']['source'], 'production_ai_briefing')
        self.assertEqual(create_response.data['input_payload']['model_id'], 'qwen38')
        self.assertNotEqual(
            create_response.data['input_payload']['briefing']['answer'],
            'untrusted client briefing',
        )

        self.client.force_authenticate(user=None)
        claim_response = self.client.post(
            '/api/ai/jobs/claim/',
            {
                'worker_name': 'test-worker',
                'worker_version': 'production-ai-worker-v2',
                'limit': 1,
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(claim_response.status_code, 200)
        self.assertEqual(claim_response.data['jobs'][0]['id'], job_id)
        self.assertEqual(claim_response.data['jobs'][0]['status'], AiJob.STATUS_CLAIMED)
        lease = {
            'worker_name': 'test-worker',
            'claim_timestamp': claim_response.data['jobs'][0]['claimed_at'],
        }

        start_response = self.client.post(
            f'/api/ai/jobs/{job_id}/start/',
            lease,
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(start_response.status_code, 200)
        self.assertEqual(start_response.data['status'], AiJob.STATUS_RUNNING)

        complete_response = self.client.post(
            f'/api/ai/jobs/{job_id}/complete/',
            {
                'result_payload': {'summary': 'done'},
                'model_name': 'dummy',
                'prompt_version': 'test-v1',
                **lease,
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(complete_response.status_code, 200)
        self.assertEqual(complete_response.data['status'], AiJob.STATUS_COMPLETED)
        self.assertEqual(complete_response.data['result_payload']['summary'], 'done')

    def test_generic_create_rejects_reserved_triggers(self):
        for trigger in ('hourly', 'question', 'worker_heartbeat'):
            response = self.client.post('/api/ai/jobs/', {
                'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
                'scope': {'date': '2026-05-15', 'language': 'ko', 'trigger': trigger},
            }, format='json')
            self.assertEqual(response.status_code, 400, trigger)
        self.assertEqual(AiJob.objects.count(), 0)

    def test_generic_create_rate_limits_manual_job_flood(self):
        payload = {
            'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
            'scope': {'date': '2026-05-15', 'language': 'ko'},
        }
        first = self.client.post('/api/ai/jobs/', payload, format='json')
        second = self.client.post('/api/ai/jobs/', payload, format='json')

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.data['code'], 'manual_ai_job_rate_limited')
        self.assertEqual(AiJob.objects.count(), 1)

    def test_claim_requires_supported_worker_version(self):
        self.client.force_authenticate(user=None)
        missing = self.client.post(
            '/api/ai/jobs/claim/',
            {'worker_name': 'test-worker'},
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        old = self.client.post(
            '/api/ai/jobs/claim/',
            {'worker_name': 'test-worker', 'worker_version': 'production-ai-worker-v1'},
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(missing.status_code, 400)
        self.assertEqual(old.status_code, 409)
        self.assertEqual(old.data['code'], 'unsupported_worker_version')
        self.assertEqual(old.data['supported_worker_version'], 'production-ai-worker-v2')

    def test_worker_token_is_required(self):
        self.client.force_authenticate(user=None)
        response = self.client.post('/api/ai/jobs/claim/', {'worker_name': 'test-worker'}, format='json')
        self.assertEqual(response.status_code, 403)

    def test_worker_claim_prioritizes_hourly_job_over_older_question(self):
        question_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'question',
                'model_id': 'qwen38',
            },
            created_by=self.user,
        )
        hourly_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
            created_by=None,
        )

        self.client.force_authenticate(user=None)
        response = self.client.post(
            '/api/ai/jobs/claim/',
            {
                'worker_name': 'test-worker',
                'worker_version': 'production-ai-worker-v2',
                'limit': 1,
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual([job['id'] for job in response.data['jobs']], [hourly_job.id])
        question_job.refresh_from_db()
        self.assertEqual(question_job.status, AiJob.STATUS_PENDING)

    def test_claim_filters_all_model_jobs_by_advertised_capability(self):
        qwen38_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
        )
        retired_jobs = [
            AiJob.objects.create(
                job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
                scope={
                    'date': '2026-05-15',
                    'language': 'ko',
                    'trigger': 'hourly',
                    **({'model_id': model_id} if model_id else {}),
                },
            )
            for model_id in ['qwen35', 'gemma4_26b_a4b', None]
        ]

        self.client.force_authenticate(user=None)
        response = self.client.post(
            '/api/ai/jobs/claim/',
            {
                'worker_name': 'qwen38-worker',
                'worker_version': 'production-ai-worker-v2',
                'limit': 10,
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual([job['id'] for job in response.data['jobs']], [qwen38_job.id])
        for retired_job in retired_jobs:
            retired_job.refresh_from_db()
            self.assertEqual(retired_job.status, AiJob.STATUS_PENDING)

        qwen38_job.status = AiJob.STATUS_PENDING
        qwen38_job.claimed_by = ''
        qwen38_job.claimed_at = None
        qwen38_job.save(update_fields=['status', 'claimed_by', 'claimed_at', 'updated_at'])
        empty_capability = self.client.post(
            '/api/ai/jobs/claim/',
            {
                'worker_name': 'no-model-worker',
                'worker_version': 'production-ai-worker-v2',
                'limit': 10,
                'available_model_ids': [],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(empty_capability.status_code, 200)
        self.assertEqual(empty_capability.data['jobs'], [])

    def test_reclaimed_job_rejects_the_previous_worker_lease(self):
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
        )
        self.client.force_authenticate(user=None)

        first_claim = self.client.post(
            '/api/ai/jobs/claim/',
            {
                'worker_name': 'worker-a',
                'worker_version': 'production-ai-worker-v2',
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        old_claimed_at = first_claim.data['jobs'][0]['claimed_at']
        AiJob.objects.filter(pk=job.pk).update(
            status=AiJob.STATUS_PENDING,
            claimed_by='',
            claimed_at=None,
            started_at=None,
        )
        second_claim = self.client.post(
            '/api/ai/jobs/claim/',
            {
                'worker_name': 'worker-b',
                'worker_version': 'production-ai-worker-v2',
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        new_claimed_at = second_claim.data['jobs'][0]['claimed_at']

        stale_start = self.client.post(
            f'/api/ai/jobs/{job.id}/start/',
            {'worker_name': 'worker-a', 'claim_timestamp': old_claimed_at},
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(stale_start.status_code, 403)

        current_start = self.client.post(
            f'/api/ai/jobs/{job.id}/start/',
            {'worker_name': 'worker-b', 'claim_timestamp': new_claimed_at},
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(current_start.status_code, 200)

        stale_complete = self.client.post(
            f'/api/ai/jobs/{job.id}/complete/',
            {
                'result_payload': {'summary': 'stale result'},
                'worker_name': 'worker-a',
                'claim_timestamp': old_claimed_at,
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(stale_complete.status_code, 403)
        job.refresh_from_db()
        self.assertEqual(job.status, AiJob.STATUS_RUNNING)

    def test_hourly_completion_restores_server_authoritative_fields(self):
        authoritative = {
            'answer': 'server-owned briefing answer',
            'severity': 'warning',
            'facts': {'actual_qty': 120},
            'top_risks': [{'type': 'delay', 'label': '1호기', 'gap_qty': -25}],
            'used_data': [{'name': 'production_plan', 'row_count': 2}],
            'calculation_basis': ['backend calculation'],
            'data_freshness': {'is_stale': False},
            'warnings': [],
            'retrieval_trace': ['production.plan:date=2026-05-15'],
        }
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_RUNNING,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
            input_payload={'briefing': authoritative},
            claimed_by='test-worker',
            claimed_at=timezone.now(),
            created_by=None,
        )
        tampered = {
            'summary': 'worker-written prose',
            'model_id': 'gemma4_26b_a4b',
            **{field: 'tampered' for field in authoritative},
        }

        self.client.force_authenticate(user=None)
        response = self.client.post(
            f'/api/ai/jobs/{job.id}/complete/',
            {
                'result_payload': tampered,
                'worker_name': job.claimed_by,
                'claim_timestamp': job.claimed_at.isoformat(),
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['result_payload']['summary'], 'worker-written prose')
        for field, expected in authoritative.items():
            self.assertEqual(response.data['result_payload'][field], expected)
        self.assertEqual(response.data['result_payload']['model_id'], 'qwen38')

    def test_question_completion_uses_deterministic_then_verified_context(self):
        deterministic = {
            'answer': 'server-owned question answer',
            'facts': {'machine': '1호기', 'actual_qty': 50},
            'used_data': [{'name': 'verified_machine_rows', 'row_count': 1}],
        }
        verified_context = {
            'facts': {'machine': 'untrusted-fallback'},
            'calculation_basis': ['verified backend metric functions'],
            'data_freshness': {'last_mes_recorded_at': '2026-05-15T10:00:00+08:00'},
            'warnings': [],
            'retrieval_trace': ['injection.monitoring:verified'],
        }
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_CLAIMED,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'question',
                'model_id': 'qwen38',
            },
            input_payload={
                'deterministic': deterministic,
                'verified_context': verified_context,
            },
            claimed_by='test-worker',
            claimed_at=timezone.now(),
            created_by=self.user,
        )
        worker_result = {
            'answer': 'worker-written answer',
            'summary': 'worker-written summary',
            'facts': {'actual_qty': 999999},
            'used_data': [],
            'calculation_basis': ['invented'],
            'data_freshness': {'is_stale': True},
            'warnings': ['invented'],
            'retrieval_trace': ['invented'],
        }

        self.client.force_authenticate(user=None)
        response = self.client.post(
            f'/api/ai/jobs/{job.id}/complete/',
            {
                'result_payload': worker_result,
                'worker_name': job.claimed_by,
                'claim_timestamp': job.claimed_at.isoformat(),
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(response.status_code, 200)
        result = response.data['result_payload']
        self.assertEqual(result['answer'], deterministic['answer'])
        self.assertEqual(result['summary'], 'worker-written summary')
        self.assertEqual(result['facts'], deterministic['facts'])
        self.assertEqual(result['used_data'], deterministic['used_data'])
        for field in ('calculation_basis', 'data_freshness', 'warnings', 'retrieval_trace'):
            self.assertEqual(result[field], verified_context[field])

    def test_machine_analysis_job_builds_backend_context_payload(self):
        response = self.client.post('/api/ai/jobs/', {
            'job_type': AiJob.JOB_TYPE_PRODUCTION_MACHINE,
            'scope': {'date': '2026-05-15', 'language': 'ko', 'machine': '850T-1'},
        }, format='json')

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['input_payload']['source'], 'production_machine_analysis')
        self.assertEqual(response.data['input_payload']['date'], '2026-05-15')
        self.assertEqual(response.data['scope']['model_id'], 'qwen38')
        self.assertEqual(response.data['input_payload']['model_id'], 'qwen38')
        self.assertIn('context_pack', response.data['input_payload'])

    def test_worker_periodic_enqueue_is_idempotent_within_hour(self):
        self.client.force_authenticate(user=None)
        headers = {'HTTP_X_AI_WORKER_TOKEN': 'test-worker-token'}

        first = self.client.post(
            '/api/ai/jobs/enqueue-periodic/',
            {'languages': ['ko', 'zh']},
            format='json',
            **headers,
        )
        second = self.client.post(
            '/api/ai/jobs/enqueue-periodic/',
            {'languages': ['ko', 'zh']},
            format='json',
            **headers,
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.data['created_count'], 2)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.data['created_count'], 0)
        hourly_jobs = AiJob.objects.filter(scope__trigger='hourly')
        self.assertEqual(hourly_jobs.count(), 2)
        self.assertEqual(
            {job.scope['model_id'] for job in hourly_jobs},
            {'qwen38'},
        )
        self.assertTrue(all(job.input_payload['model_id'] == job.scope['model_id'] for job in hourly_jobs))

    def test_latest_job_returns_completed_system_analysis(self):
        system_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
            result_payload={'summary': 'verified hourly result'},
        )

        response = self.client.get('/api/ai/jobs/latest/', {
            'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
            'date': '2026-05-15',
            'language': 'ko',
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['job']['id'], system_job.id)
        self.assertEqual(response.data['job']['result_payload']['summary'], 'verified hourly result')
        self.assertNotIn('input_payload', response.data['job'])

    def test_latest_job_ignores_completed_question_jobs(self):
        system_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
            result_payload={'summary': 'verified hourly result'},
            completed_at=timezone.now() - timedelta(minutes=1),
        )
        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={'date': '2026-05-15', 'language': 'ko', 'trigger': 'question'},
            result_payload={'summary': 'newer question result'},
            created_by=self.user,
            completed_at=timezone.now(),
        )

        response = self.client.get('/api/ai/jobs/latest/', {
            'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
            'date': '2026-05-15',
            'language': 'ko',
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['job']['id'], system_job.id)

    def test_latest_job_returns_only_canonical_qwen38_history(self):
        qwen38_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
            result_payload={'summary': 'qwen38 summary', 'model_id': 'qwen38'},
            completed_at=timezone.now() - timedelta(minutes=2),
        )
        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={
                'date': '2026-05-15',
                'language': 'ko',
                'trigger': 'hourly',
            },
            result_payload={'summary': 'newer model-less legacy result'},
            completed_at=timezone.now(),
        )

        qwen38_response = self.client.get('/api/ai/jobs/latest/', {
            'date': '2026-05-15',
            'language': 'ko',
        })
        alias_response = self.client.get('/api/ai/jobs/latest/', {
            'date': '2026-05-15',
            'language': 'ko',
            'model_id': 'qwen35',
        })
        retired_response = self.client.get('/api/ai/jobs/latest/', {
            'date': '2026-05-15',
            'language': 'ko',
            'model_id': 'gemma4_26b_a4b',
        })

        self.assertEqual(qwen38_response.data['job']['id'], qwen38_job.id)
        self.assertEqual(alias_response.data['job']['id'], qwen38_job.id)
        self.assertEqual(retired_response.status_code, 400)

    def test_worker_heartbeat_and_authenticated_status(self):
        self.client.force_authenticate(user=None)
        heartbeat_response = self.client.post(
            '/api/ai/worker/heartbeat/',
            {
                'worker_name': 'mac-studio-test',
                'llm_enabled': True,
                'llm_ready': True,
                'model_name': '/private/models/Qwen3.8-test',
                'worker_version': 'production-ai-worker-v2',
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(heartbeat_response.status_code, 200)
        self.assertEqual(heartbeat_response.data['model_name'], 'Qwen3.8-test')
        self.assertEqual(
            heartbeat_response.data['available_model_ids'],
            ['qwen38'],
        )

        second_heartbeat = self.client.post(
            '/api/ai/worker/heartbeat/',
            {
                'worker_name': 'mac-studio-test',
                'llm_ready': False,
                'worker_version': 'production-ai-worker-v2',
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(second_heartbeat.status_code, 200)
        self.assertEqual(AiJob.objects.filter(job_type='worker_heartbeat').count(), 1)

        AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={
                'date': '2026-08-03',
                'language': 'ko',
                'trigger': 'hourly',
                'model_id': 'qwen38',
            },
            result_payload={
                'summary': 'safe fallback',
                'llm_fallback': True,
                'model_id': 'qwen38',
            },
            model_name='/private/models/Qwen3.8-hourly',
            completed_at=timezone.now(),
            created_by=None,
        )

        self.client.force_authenticate(self.user)
        status_response = self.client.get('/api/ai/worker/status/', {'language': 'ko'})
        self.assertEqual(status_response.status_code, 200)
        self.assertEqual(status_response.data['state'], 'online')
        self.assertEqual(status_response.data['stale_after_seconds'], 300)
        self.assertTrue(status_response.data['worker_compatible'])
        self.assertFalse(status_response.data['llm_ready'])
        self.assertEqual(status_response.data['last_analysis_model_name'], 'Qwen3.8-hourly')
        self.assertTrue(status_response.data['last_analysis_llm_fallback'])
        self.assertIsNotNone(status_response.data['last_analysis_completed_at'])
        job_list = self.client.get('/api/ai/jobs/').data
        rows = job_list.get('results', []) if isinstance(job_list, dict) else job_list
        self.assertNotIn('worker_heartbeat', [row['job_type'] for row in rows])

    def test_status_hides_models_from_incompatible_worker_version(self):
        self.client.force_authenticate(user=None)
        heartbeat = self.client.post(
            '/api/ai/worker/heartbeat/',
            {
                'worker_name': 'legacy-worker',
                'llm_enabled': True,
                'llm_ready': True,
                'model_name': '/private/models/Qwen3.8-27B-4bit',
                'worker_version': 'production-ai-worker-v1',
                'available_model_ids': ['qwen38'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(heartbeat.status_code, 200)

        self.client.force_authenticate(self.user)
        response = self.client.get('/api/ai/worker/status/', {'language': 'ko'})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['state'], 'online')
        self.assertFalse(response.data['worker_compatible'])
        self.assertFalse(response.data['llm_ready'])
        self.assertEqual(response.data['available_model_ids'], [])

    def test_worker_heartbeat_rejects_unknown_model_id(self):
        self.client.force_authenticate(user=None)
        response = self.client.post(
            '/api/ai/worker/heartbeat/',
            {
                'worker_name': 'mac-studio-test',
                'available_model_ids': ['unknown-model'],
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('available_model_ids', response.data)

    def test_worker_status_is_unknown_without_heartbeat_and_offline_when_stale(self):
        unknown = self.client.get('/api/ai/worker/status/')
        self.assertEqual(unknown.status_code, 200)
        self.assertEqual(unknown.data['state'], 'unknown')

        heartbeat = AiJob.objects.create(
            job_type='worker_heartbeat',
            status=AiJob.STATUS_COMPLETED,
            scope={'trigger': 'worker_heartbeat', 'worker_name': 'stale-worker'},
            result_payload={'llm_ready': True},
            completed_at=timezone.now() - timedelta(minutes=10),
        )
        AiJob.objects.filter(pk=heartbeat.pk).update(
            completed_at=timezone.now() - timedelta(minutes=10),
        )
        offline = self.client.get('/api/ai/worker/status/')
        self.assertEqual(offline.status_code, 200)
        self.assertEqual(offline.data['state'], 'offline')

    @override_settings(AI_WORKER_HEARTBEAT_STALE_SECONDS=420)
    def test_worker_status_honors_stale_threshold_setting(self):
        response = self.client.get('/api/ai/worker/status/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['stale_after_seconds'], 420)

    def test_worker_heartbeat_requires_worker_token(self):
        self.client.force_authenticate(user=None)
        response = self.client.post(
            '/api/ai/worker/heartbeat/',
            {'worker_name': 'unauthorized-worker'},
            format='json',
        )
        self.assertEqual(response.status_code, 403)

    def test_user_cannot_read_or_cancel_another_users_job(self):
        other_user = get_user_model().objects.create_user(username='other-ai-user', password='test-pass')
        other_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={'date': '2026-05-15', 'language': 'ko'},
            created_by=other_user,
        )

        detail_response = self.client.get(f'/api/ai/jobs/{other_job.id}/')
        cancel_response = self.client.post(f'/api/ai/jobs/{other_job.id}/cancel/', {}, format='json')

        self.assertEqual(detail_response.status_code, 404)
        self.assertEqual(cancel_response.status_code, 404)

    def test_deleted_users_question_job_does_not_become_system_visible(self):
        deleted_user = get_user_model().objects.create_user(
            username='deleted-ai-user',
            password='test-pass',
        )
        deleted_question = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={'date': '2026-05-15', 'language': 'ko', 'trigger': 'question'},
            input_payload={
                'question': 'private production question',
                'conversation_history': [{'role': 'user', 'content': 'private history'}],
            },
            created_by=deleted_user,
        )
        hourly_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            scope={'date': '2026-05-15', 'language': 'ko', 'trigger': 'hourly'},
            created_by=None,
        )
        deleted_user.delete()
        deleted_question.refresh_from_db()
        self.assertIsNone(deleted_question.created_by)

        list_response = self.client.get('/api/ai/jobs/')
        rows = list_response.data.get('results', list_response.data)
        visible_ids = [row['id'] for row in rows]

        self.assertNotIn(deleted_question.id, visible_ids)
        self.assertIn(hourly_job.id, visible_ids)
        self.assertEqual(
            self.client.get(f'/api/ai/jobs/{deleted_question.id}/').status_code,
            404,
        )


@unittest.skipUnless(
    os.getenv('RUN_LOCAL_AI_INTEGRATION') == '1',
    'Set RUN_LOCAL_AI_INTEGRATION=1 with the local MLX server running.',
)
@override_settings(AI_WORKER_TOKEN='integration-worker-token')
class LocalAiWorkerIntegrationTests(LiveServerTestCase):
    """Exercise the real API/Worker/Qwen/result-readback path against a test DB."""

    def test_periodic_job_runs_through_local_qwen_and_latest_api(self):
        repo_root = Path(__file__).resolve().parents[2]
        worker_dir = repo_root / 'local_worker'
        sys.path.insert(0, str(worker_dir))
        try:
            from llm_client import LocalLlmClient
            from render_client import RenderClient
            from worker import handle_job

            model_name = os.getenv(
                'LOCAL_LLM_MODEL',
                '/Users/macstudio_ted/Developer/local-ai/models/Qwen3.8-27B-4bit',
            )
            render_client = RenderClient(
                api_base_url=f'{self.live_server_url}/api',
                worker_token='integration-worker-token',
            )
            llm = LocalLlmClient(
                base_url=os.getenv('LOCAL_LLM_BASE_URL', 'http://127.0.0.1:8082/v1'),
                model=model_name,
                timeout=120,
            )
            render_client.send_heartbeat(
                'integration-test-worker',
                llm_enabled=True,
                llm_ready=True,
                model_name=model_name,
                worker_version='production-ai-worker-v2',
                available_model_ids=['qwen38'],
            )

            enqueue_result = render_client.enqueue_periodic_jobs(['ko'])
            self.assertEqual(enqueue_result['created_count'], 1)
            self.assertEqual(render_client.enqueue_periodic_jobs(['ko'])['created_count'], 0)

            jobs = render_client.claim_jobs(
                worker_name='integration-test-worker',
                limit=1,
                job_types=[AiJob.JOB_TYPE_PRODUCTION_DAILY],
                available_model_ids=['qwen38'],
            )
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            render_client.start_job(
                job['id'],
                worker_name='integration-test-worker',
                claim_timestamp=job['claimed_at'],
            )

            result, prompt_version = handle_job(
                job,
                use_llm=True,
                llm=llm,
                model_name=model_name,
                fallback_to_deterministic=False,
            )
            self.assertEqual(result['source'], 'local_llm_rewrite')
            self.assertEqual(result['model_name'], model_name)
            self.assertIn('facts', result)
            self.assertIn('retrieval_trace', result)

            completed = render_client.complete_job(
                job['id'],
                result_payload=result,
                model_name=result['model_name'],
                prompt_version=prompt_version,
                worker_name='integration-test-worker',
                claim_timestamp=job['claimed_at'],
            )
            self.assertEqual(completed['status'], AiJob.STATUS_COMPLETED)

            username = 'integration-ai-user'
            password = 'integration-test-pass'
            get_user_model().objects.create_user(username=username, password=password)
            token_response = requests.post(
                f'{self.live_server_url}/api/token/',
                json={'username': username, 'password': password},
                timeout=30,
            )
            token_response.raise_for_status()
            latest_response = requests.get(
                f'{self.live_server_url}/api/ai/jobs/latest/',
                params={
                    'job_type': AiJob.JOB_TYPE_PRODUCTION_DAILY,
                    'date': job['scope']['date'],
                    'language': 'ko',
                },
                headers={'Authorization': f"Bearer {token_response.json()['access']}"},
                timeout=30,
            )
            latest_response.raise_for_status()
            latest = latest_response.json()['job']
            self.assertEqual(latest['id'], job['id'])
            self.assertEqual(latest['result_payload']['source'], 'local_llm_rewrite')
            self.assertNotIn('input_payload', latest)
        finally:
            if sys.path and sys.path[0] == str(worker_dir):
                sys.path.pop(0)

    def test_verified_question_runs_through_local_qwen_and_result_polling_api(self):
        repo_root = Path(__file__).resolve().parents[2]
        worker_dir = repo_root / 'local_worker'
        sys.path.insert(0, str(worker_dir))
        try:
            from llm_client import LocalLlmClient
            from render_client import RenderClient
            from worker import handle_job

            username = 'integration-question-user'
            password = 'integration-question-pass'
            get_user_model().objects.create_user(username=username, password=password)
            token_response = requests.post(
                f'{self.live_server_url}/api/token/',
                json={'username': username, 'password': password},
                timeout=30,
            )
            token_response.raise_for_status()
            auth_headers = {'Authorization': f"Bearer {token_response.json()['access']}"}
            render_client = RenderClient(
                api_base_url=f'{self.live_server_url}/api',
                worker_token='integration-worker-token',
            )
            render_client.send_heartbeat(
                'integration-question-worker',
                llm_enabled=True,
                llm_ready=True,
                model_name=os.getenv(
                    'LOCAL_LLM_MODEL',
                    '/Users/macstudio_ted/Developer/local-ai/models/Qwen3.8-27B-4bit',
                ),
                worker_version='production-ai-worker-v2',
                available_model_ids=['qwen38'],
            )
            ask_response = requests.post(
                f'{self.live_server_url}/api/production/ai/ask/',
                json={
                    'date': '2026-08-03',
                    'language': 'ko',
                    'question': '현재 데이터에서 관리자가 먼저 확인할 내용을 설명해줘',
                },
                headers=auth_headers,
                timeout=30,
            )
            ask_response.raise_for_status()
            ask_payload = ask_response.json()
            self.assertEqual(ask_payload['source'], 'ai_queued')
            self.assertEqual(ask_payload['job_status'], AiJob.STATUS_PENDING)

            model_name = os.getenv(
                'LOCAL_LLM_MODEL',
                '/Users/macstudio_ted/Developer/local-ai/models/Qwen3.8-27B-4bit',
            )
            llm = LocalLlmClient(
                base_url=os.getenv('LOCAL_LLM_BASE_URL', 'http://127.0.0.1:8082/v1'),
                model=model_name,
                timeout=120,
            )
            jobs = render_client.claim_jobs(
                worker_name='integration-question-worker',
                limit=1,
                job_types=[AiJob.JOB_TYPE_PRODUCTION_DAILY],
                available_model_ids=['qwen38'],
            )
            self.assertEqual([job['id'] for job in jobs], [ask_payload['job_id']])
            job = jobs[0]
            render_client.start_job(
                job['id'],
                worker_name='integration-question-worker',
                claim_timestamp=job['claimed_at'],
            )
            result, prompt_version = handle_job(
                job,
                use_llm=True,
                llm=llm,
                model_name=model_name,
                fallback_to_deterministic=False,
            )
            verified_fallback = job['input_payload']['deterministic']
            self.assertEqual(result['answer'], verified_fallback['answer'])
            self.assertEqual(result['facts'], verified_fallback['facts'])
            self.assertTrue(result['summary'])
            self.assertEqual(result['source'], 'local_llm_rewrite')
            render_client.complete_job(
                job['id'],
                result_payload=result,
                model_name=result['model_name'],
                prompt_version=prompt_version,
                worker_name='integration-question-worker',
                claim_timestamp=job['claimed_at'],
            )

            detail_response = requests.get(
                f"{self.live_server_url}/api/ai/jobs/{job['id']}/",
                headers=auth_headers,
                timeout=30,
            )
            detail_response.raise_for_status()
            detail = detail_response.json()
            self.assertEqual(detail['status'], AiJob.STATUS_COMPLETED)
            self.assertEqual(detail['result_payload']['source'], 'local_llm_rewrite')
            self.assertNotEqual(detail['result_payload']['answer'], ask_payload['answer'])
            self.assertTrue(detail['result_payload']['summary'])
        finally:
            if sys.path and sys.path[0] == str(worker_dir):
                sys.path.pop(0)
