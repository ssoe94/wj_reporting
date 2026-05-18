from django.contrib.auth import get_user_model
from django.test import override_settings
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
            'input_payload': {'briefing': {'answer': 'test briefing'}},
        }, format='json')

        self.assertEqual(create_response.status_code, 201)
        job_id = create_response.data['id']
        self.assertEqual(create_response.data['status'], AiJob.STATUS_PENDING)

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
