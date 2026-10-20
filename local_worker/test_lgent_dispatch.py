import unittest
from unittest.mock import Mock, patch

from . import lgent_dispatch


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def job(number):
    return {'id': number, 'claimed_at': '2026-10-21T00:00:00Z'}


class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.client.complete_job.return_value = {'status': 'completed'}
        self.clock = Clock()

    def dispatcher(self, lock=None):
        return lgent_dispatch.Dispatcher(self.client, Mock(), 'mac-studio-local-ai', lock, clock=self.clock)

    def test_idle_poll_heartbeats_once_a_minute_under_lgent_name(self):
        self.client.claim_jobs.return_value = []
        value = self.dispatcher()
        self.assertEqual(value.poll(True), 0)
        self.clock.now = 30
        value.poll(True)
        self.assertEqual(self.client.send_heartbeat.call_count, 1)
        self.assertEqual(self.client.send_heartbeat.call_args.args[0], 'mac-studio-local-ai-lgent')
        self.assertEqual(self.client.claim_jobs.call_args.kwargs['job_types'], ['lgent_trolley_photo'])
        self.clock.now = 61
        value.poll(True)
        self.assertEqual(self.client.send_heartbeat.call_count, 2)

    def test_claims_queued_photos_up_to_batch_and_refreshes_heartbeat(self):
        self.client.claim_jobs.side_effect = [[job(1)], [job(2)], []]
        value = self.dispatcher()
        with patch.object(lgent_dispatch.trolley_recognition, 'analyze', return_value=({'primary_id': 'TT0940001'}, 'v1')):
            self.assertEqual(value.poll(True), 2)
        self.assertEqual(self.client.complete_job.call_count, 2)
        self.assertEqual(value.next_heartbeat, 0.0)

    def test_failed_analysis_fails_the_job_and_continues(self):
        self.client.claim_jobs.side_effect = [[job(1)], []]
        with patch.object(lgent_dispatch.trolley_recognition, 'analyze', side_effect=ValueError('bad photo')):
            self.assertEqual(self.dispatcher().poll(True), 1)
        self.assertEqual(self.client.fail_job.call_args.args[:2], (1, 'ValueError'))
        self.client.complete_job.assert_not_called()

    def test_model_not_ready_or_lock_busy_claims_nothing(self):
        self.assertEqual(self.dispatcher().poll(False), 0)
        self.assertFalse(self.client.send_heartbeat.call_args.kwargs['llm_ready'])
        lock = Mock()
        lock.acquire.return_value = False
        self.assertEqual(self.dispatcher(lock).poll(True), 0)
        self.client.claim_jobs.assert_not_called()
        lock.release.assert_not_called()

    def test_lock_released_after_work(self):
        self.client.claim_jobs.return_value = []
        lock = Mock()
        lock.acquire.return_value = True
        self.dispatcher(lock).poll(True)
        lock.release.assert_called_once()


if __name__ == '__main__':
    unittest.main()
