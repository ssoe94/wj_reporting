import hashlib
import unittest
import io
from copy import deepcopy
from unittest.mock import Mock, patch

from local_worker.worker import HANDLERS, handle_job, run_once
from local_worker.job_handlers import quality_action_result_translation as handler


class QualityActionResultTranslationTests(unittest.TestCase):
    def job(self, source='CS确认不良4ea 返工'):
        scope = {'report_id': 7, 'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
                 'model_id': 'qwen38', 'language': 'ko', 'prompt_version': handler.PROMPT_VERSION}
        return {'job_type': 'quality_action_result_translation', 'scope': scope,
                'input_payload': {**scope, 'source_text': source, 'schema_version': handler.SCHEMA_VERSION}}

    def test_routing_preserves_source_and_uses_schema_without_summary_fallback(self):
        job = self.job()
        original = deepcopy(job)
        llm = Mock()
        llm.structured_analysis.return_value = {'translation': 'CS 불량4ea 확인, 재작업'}
        result, version = handle_job(job, True, llm, 'Qwen3.8-27B-4bit', True)
        self.assertIs(HANDLERS['quality_action_result_translation'], handler)
        self.assertEqual(job, original)
        self.assertEqual(version, handler.PROMPT_VERSION)
        self.assertEqual(result['translation'], 'CS 불량4ea 확인, 재작업')
        self.assertEqual(result['source_sha256'], job['scope']['source_sha256'])
        self.assertFalse(result['llm_fallback'])
        self.assertNotIn('summary', result)
        self.assertEqual(llm.structured_analysis.call_args.args[1], {'source': job['input_payload']['source_text']})
        self.assertEqual(llm.structured_analysis.call_args.kwargs['json_schema'], handler.OUTPUT_SCHEMA)

    def test_invalid_identity_fails_before_model_call(self):
        for field, value in [('schema_version', 'other'), ('source_sha256', '0' * 64),
                             ('model_id', 'chatgpt'), ('prompt_version', 'old'), ('language', 'zh'), ('report_id', True)]:
            with self.subTest(field=field):
                job = self.job()
                job['input_payload'][field] = value
                llm = Mock()
                with self.assertRaises(ValueError):
                    handle_job(job, True, llm, 'Qwen3.8-27B-4bit', True)
                llm.structured_analysis.assert_not_called()

    def test_disabled_or_missing_model_does_not_create_translation(self):
        for enabled, llm in [(False, Mock()), (True, None)]:
            with self.assertRaises(RuntimeError):
                handle_job(self.job(), enabled, llm, '', True)

    def test_protected_name_is_restored_without_transliteration(self):
        llm = Mock()
        llm.structured_analysis.return_value = {'translation': '업체: KEEP_NAME_0, 반품'}
        result, _ = handle_job(self.job('厂家：紫金 退货'), True, llm, 'Qwen3.8-27B-4bit', True)
        self.assertEqual(result['translation'], '업체: 紫金, 반품')
        self.assertEqual(llm.structured_analysis.call_args.args[1], {'source': '厂家：KEEP_NAME_0 退货'})

    def test_invalid_output_is_rejected_without_model_repair_or_fallback(self):
        for source, translated in [('返工', '재작업 완료'), ('CS不良4ea', 'CS 불량5ea'),
                                  ('厂家：紫金 退货', '업체: 자금, 반품'), ('误差-5mm', '오차5mm'),
                                  ('不良率10%', '불량률10'), ('返工 报废', '재작업'),
                                  ('擦拭', '세척'), ('返工', ''), ('返工', '返工')]:
            llm = Mock()
            llm.structured_analysis.return_value = {'translation': translated}
            with self.subTest(source=source), self.assertRaises(ValueError):
                handle_job(self.job(source), True, llm, 'Qwen3.8-27B-4bit', True)
            self.assertEqual(llm.structured_analysis.call_count, 1)

    def test_scope_mismatch_and_long_source_are_rejected(self):
        job = self.job()
        job['scope']['report_id'] = 8
        with self.assertRaises(ValueError):
            handler.handle(job, Mock(), '')
        with self.assertRaises(ValueError):
            handler.handle(self.job('返工' * 3100), Mock(), '')

    def test_completion_log_uses_server_acceptance(self):
        for accepted, expected in [(True, 'llm_success'), (False, 'server_rejected')]:
            job = {**self.job(), 'id': 7, 'claimed_at': '2026-10-10T00:00:00Z'}
            llm = Mock()
            llm.is_ready.return_value = True
            llm.structured_analysis.return_value = {'translation': 'CS 확인 불량4ea, 재작업'}
            client = Mock()
            client.claim_jobs.return_value = [job]
            client.complete_job.return_value = {'status': 'completed', 'result_payload': {
                'source': 'local_qwen38_translation', 'accepted_translation': accepted}}
            output = io.StringIO()
            with patch('sys.stdout', output):
                run_once(client, 'translation-test', True, llm, 'Qwen3.8-27B-4bit', True, False)
            self.assertIn('outcome=' + expected, output.getvalue())


if __name__ == '__main__':
    unittest.main()
