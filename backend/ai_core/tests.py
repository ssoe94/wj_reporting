import os
import sys
import unittest
from pathlib import Path

import requests
from django.contrib.auth import get_user_model
from django.test import LiveServerTestCase, override_settings
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
        self.assertEqual(create_response.data['input_payload']['source'], 'production_ai_briefing')
        self.assertNotEqual(
            create_response.data['input_payload']['briefing']['answer'],
            'untrusted client briefing',
        )

        self.client.force_authenticate(user=None)
        claim_response = self.client.post(
            '/api/ai/jobs/claim/',
            {'worker_name': 'test-worker', 'limit': 1},
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )

        self.assertEqual(claim_response.status_code, 200)
        self.assertEqual(claim_response.data['jobs'][0]['id'], job_id)
        self.assertEqual(claim_response.data['jobs'][0]['status'], AiJob.STATUS_CLAIMED)

        start_response = self.client.post(
            f'/api/ai/jobs/{job_id}/start/',
            {},
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
            },
            format='json',
            HTTP_X_AI_WORKER_TOKEN='test-worker-token',
        )
        self.assertEqual(complete_response.status_code, 200)
        self.assertEqual(complete_response.data['status'], AiJob.STATUS_COMPLETED)
        self.assertEqual(complete_response.data['result_payload']['summary'], 'done')

    def test_worker_token_is_required(self):
        self.client.force_authenticate(user=None)
        response = self.client.post('/api/ai/jobs/claim/', {'worker_name': 'test-worker'}, format='json')
        self.assertEqual(response.status_code, 403)

    def test_machine_analysis_job_builds_backend_context_payload(self):
        response = self.client.post('/api/ai/jobs/', {
            'job_type': AiJob.JOB_TYPE_PRODUCTION_MACHINE,
            'scope': {'date': '2026-05-15', 'language': 'ko', 'machine': '850T-1'},
        }, format='json')

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['input_payload']['source'], 'production_machine_analysis')
        self.assertEqual(response.data['input_payload']['date'], '2026-05-15')
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
        self.assertEqual(AiJob.objects.filter(scope__trigger='hourly').count(), 2)

    def test_latest_job_returns_completed_system_analysis(self):
        system_job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_PRODUCTION_DAILY,
            status=AiJob.STATUS_COMPLETED,
            scope={'date': '2026-05-15', 'language': 'ko', 'trigger': 'hourly'},
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
                '/Users/macstudio_ted/Developer/local-ai/models/Qwen3.5-35B-A3B-4bit',
            )
            render_client = RenderClient(
                api_base_url=f'{self.live_server_url}/api',
                worker_token='integration-worker-token',
            )
            llm = LocalLlmClient(
                base_url=os.getenv('LOCAL_LLM_BASE_URL', 'http://127.0.0.1:8080/v1'),
                model=model_name,
                timeout=120,
            )

            enqueue_result = render_client.enqueue_periodic_jobs(['ko'])
            self.assertEqual(enqueue_result['created_count'], 1)
            self.assertEqual(render_client.enqueue_periodic_jobs(['ko'])['created_count'], 0)

            jobs = render_client.claim_jobs(
                worker_name='integration-test-worker',
                limit=1,
                job_types=[AiJob.JOB_TYPE_PRODUCTION_DAILY],
            )
            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            render_client.start_job(job['id'])

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
