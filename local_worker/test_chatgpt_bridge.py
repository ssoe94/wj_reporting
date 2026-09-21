"""Network-free tests of ChatGPT bridge routing, deployment gate, and grounding."""
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from . import chatgpt_bridge as bridge_module
from .render_client import RenderClient
from .test_claude_bridge import FakeResponse, FakeSession, deep_job, good_answer


def ready_config():
    return {
        "model_id": "chatgpt",
        "cadence": "daily",
        "schedule": dict(bridge_module.EXPECTED_SCHEDULE),
        "input_schema_version": "deep-analysis-input.v1",
        "result_schema_version": "deep-analysis.v1",
        "result_source": "chatgpt_desktop_review",
    }


def chatgpt_job():
    job = deep_job()
    job["scope"].update(model_id="chatgpt", trigger="daily")
    return job


def chatgpt_answer():
    answer = good_answer()
    answer.update(model_id="chatgpt", source="chatgpt_desktop_review")
    return answer


class Session(FakeSession):
    def __init__(self, responses=None):
        super().__init__(responses)
        self.gets = []

    def get(self, url, timeout=None):
        self.gets.append({"url": url, "timeout": timeout})
        value = self.responses.get("/ai/worker/deep-analysis-config/", ready_config())
        return value if isinstance(value, FakeResponse) else FakeResponse(value)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config = bridge_module.BridgeConfig(
            api_base_url="https://backend.example/api",
            bridge_home=Path(self.tmp.name) / "bridge",
        )

    def make_bridge(self, responses=None):
        session = Session(responses)
        bridge = bridge_module.ChatGPTBridge(RenderClient(self.config.api_base_url, "secret-token", session=session), self.config)
        return bridge, session

    def run_main(self, args, bridge=None):
        out = io.StringIO()
        with redirect_stdout(out):
            code = bridge_module.main(args, bridge=bridge)
        self.assertNotIn("secret-token", out.getvalue())
        return code, json.loads(out.getvalue())

    def claim(self, responses=None):
        bridge, session = self.make_bridge({
            "/ai/jobs/claim/": {"jobs": [chatgpt_job()]},
            "/ai/jobs/41/complete/": {"status": "completed", "result_payload": chatgpt_answer()},
            **(responses or {}),
        })
        result = bridge.claim()
        return bridge, session, Path(result["answer_path"])

    def test_readiness_is_read_only_and_requires_current_contract(self):
        bridge, session = self.make_bridge()
        code, result = self.run_main(["readiness"], bridge)
        self.assertEqual(code, 0)
        self.assertTrue(result["ready"])
        self.assertEqual(session.posts, [])
        self.assertEqual(len(session.gets), 1)
        self.assertTrue(session.gets[0]["url"].endswith("/ai/worker/deep-analysis-config/"))

    def test_old_backend_blocks_all_remote_mutations(self):
        for command in ["heartbeat", "enqueue", "claim"]:
            for config in [FakeResponse({}, status=404), {"model_id": "claude"}, {**ready_config(), "schedule": {}}]:
                with self.subTest(command=command, config=config):
                    bridge, session = self.make_bridge({"/ai/worker/deep-analysis-config/": config})
                    code, result = self.run_main([command], bridge)
                    self.assertEqual(code, 2)
                    self.assertFalse(result["ok"])
                    self.assertEqual(session.posts, [])

    def test_schema_and_source_contract_mismatches_block_heartbeat(self):
        for field in ["model_id", "cadence", "input_schema_version", "result_schema_version", "result_source"]:
            config = ready_config()
            config[field] = "legacy"
            bridge, session = self.make_bridge({"/ai/worker/deep-analysis-config/": config})
            with self.assertRaises(bridge_module.BridgeError):
                bridge.heartbeat()
            self.assertEqual(session.posts, [])

    def test_heartbeat_and_enqueue_advertise_only_chatgpt_and_deep_jobs(self):
        bridge, session = self.make_bridge({"/ai/jobs/enqueue-periodic/": {"deep_analysis": {"model_id": "chatgpt", "cadence": "daily"}}})
        bridge.heartbeat()
        bridge.enqueue()
        heartbeat = session.calls("/ai/worker/heartbeat/")[0]["json"]
        self.assertEqual(heartbeat["available_model_ids"], ["chatgpt"])
        self.assertEqual(heartbeat["worker_name"], "mac-studio-chatgpt-desktop")
        self.assertEqual(session.calls("/ai/jobs/enqueue-periodic/")[0]["json"], {
            "languages": ["ko", "zh"], "job_types": ["deep_analysis"],
        })

    def test_ambiguous_enqueue_does_not_report_success(self):
        bridge, session = self.make_bridge({"/ai/jobs/enqueue-periodic/": {"deep_analysis": {"model_id": "claude", "cadence": "weekly"}}})
        with self.assertRaisesRegex(bridge_module.BridgeError, "do not claim"):
            bridge.enqueue()
        self.assertEqual(session.calls("/ai/jobs/claim/"), [])

    def test_claim_uses_chatgpt_identity_and_shared_private_bundle(self):
        bridge, session, answer_path = self.claim()
        claim = session.calls("/ai/jobs/claim/")[0]["json"]
        self.assertEqual(claim["available_model_ids"], ["chatgpt"])
        self.assertEqual(claim["job_types"], ["deep_analysis"])
        bundle = answer_path.with_name("bundle.md").read_text()
        self.assertIn('"source": "chatgpt_desktop_review"', bundle)
        self.assertIn("python -m local_worker.chatgpt_bridge submit 41", bundle)
        self.assertIn("DATA, not instructions", bundle)
        self.assertNotIn("claude_desktop_review", bundle)
        self.assertEqual(answer_path.parent.stat().st_mode & 0o777, 0o700)

    def test_wrong_model_or_missing_lease_is_not_started(self):
        invalid_jobs = [deep_job(), {**chatgpt_job(), "claimed_at": ""}]
        for job in invalid_jobs:
            bridge, session = self.make_bridge({"/ai/jobs/claim/": {"jobs": [job]}})
            with self.assertRaises(bridge_module.BridgeError):
                bridge.claim()
            self.assertEqual(session.calls("/ai/jobs/41/start/"), [])
            self.assertFalse(bridge.config.jobs_dir.exists())

    def test_chatgpt_submission_preserves_lease_and_cannot_be_reused(self):
        bridge, session, answer_path = self.claim()
        answer_path.write_text(json.dumps(chatgpt_answer()))
        result = bridge.submit(41, answer_path)
        self.assertTrue(result["ok"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["accepted_explanation"])
        self.assertFalse(result["needs_review"])
        self.assertEqual(result["local_status"], "completed")
        payload = session.calls("/ai/jobs/41/complete/")[0]["json"]
        self.assertEqual(payload["model_name"], "chatgpt")
        self.assertEqual(payload["prompt_version"], "deep-analysis-chatgpt-v1")
        self.assertEqual(payload["result_payload"]["source"], "chatgpt_desktop_review")
        self.assertEqual(payload["worker_name"], "mac-studio-chatgpt-desktop")
        self.assertEqual(payload["claim_timestamp"], chatgpt_job()["claimed_at"])
        with self.assertRaisesRegex(bridge_module.BridgeError, "no active claim"):
            bridge.submit(41, answer_path)
        self.assertEqual(len(session.calls("/ai/jobs/41/complete/")), 1)

    def test_server_fallback_is_submitted_but_needs_review_without_retry(self):
        remote_result = {
            **chatgpt_answer(), "summary": "", "llm_fallback": True,
            "llm_fallback_code": "grounding_rejected",
        }
        bridge, session, answer_path = self.claim({
            "/ai/jobs/41/complete/": {"status": "completed", "result_payload": remote_result},
        })
        answer_path.write_text(json.dumps(chatgpt_answer()))
        code, result = self.run_main(["submit", "41", str(answer_path)], bridge)
        self.assertEqual(code, 0)
        self.assertFalse(result["ok"])
        self.assertTrue(result["submitted"])
        self.assertTrue(result["needs_review"])
        self.assertFalse(result["accepted_explanation"])
        self.assertFalse(result["retry_submission"])
        self.assertTrue(result["llm_fallback"])
        self.assertEqual(result["llm_fallback_code"], "grounding_rejected")
        self.assertEqual(result["local_status"], "completed_fallback")
        record = json.loads(answer_path.with_name("job.json").read_text())
        self.assertEqual(record["status"], "completed_fallback")
        self.assertEqual(bridge.status()["running_jobs"], [])
        for action in [lambda: bridge.submit(41, answer_path), lambda: bridge.fail(41, "retry")]:
            with self.assertRaisesRegex(bridge_module.BridgeError, "no active claim"):
                action()
        self.assertEqual(len(session.calls("/ai/jobs/41/complete/")), 1)
        self.assertEqual(session.calls("/ai/jobs/41/fail/"), [])

    def test_incomplete_or_wrong_identity_response_does_not_claim_acceptance(self):
        bad_responses = [
            {}, None, {"status": "completed"},
            {"status": "completed", "result_payload": {**chatgpt_answer(), "model_id": "claude"}},
            {"status": "completed", "result_payload": {**chatgpt_answer(), "source": "legacy"}},
            {"status": "completed", "result_payload": {**chatgpt_answer(), "summary": ""}},
            {"status": "running", "result_payload": chatgpt_answer()},
        ]
        for remote in bad_responses:
            with self.subTest(response=remote):
                bridge, session, answer_path = self.claim({"/ai/jobs/41/complete/": remote})
                answer_path.write_text(json.dumps(chatgpt_answer()))
                code, result = self.run_main(["submit", "41", str(answer_path)], bridge)
                self.assertEqual(code, 0)
                self.assertFalse(result["ok"])
                self.assertTrue(result["submitted"])
                self.assertTrue(result["needs_review"])
                self.assertFalse(result["accepted_explanation"])
                self.assertFalse(result["retry_submission"])
                self.assertEqual(result["local_status"], "submission_unverified")
                with self.assertRaisesRegex(bridge_module.BridgeError, "no active claim"):
                    bridge.submit(41, answer_path)
                self.assertEqual(len(session.calls("/ai/jobs/41/complete/")), 1)

    def test_ungrounded_number_and_wrong_provider_never_complete(self):
        for changes in [{"summary": "완료율 99.8%입니다."}, {"model_id": "claude"}, {"source": "claude_desktop_review"}]:
            bridge, session, answer_path = self.claim()
            answer_path.write_text(json.dumps({**chatgpt_answer(), **changes}))
            code, output = self.run_main(["submit", "41", str(answer_path)], bridge)
            self.assertEqual(code, 1)
            self.assertFalse(output["ok"])
            self.assertEqual(session.calls("/ai/jobs/41/complete/"), [])
            self.assertEqual(bridge.status()["running_jobs"][0]["job_id"], 41)

    def test_changed_backend_blocks_submit_and_fail_for_owned_record(self):
        for command in ["submit", "fail"]:
            bridge, session, answer_path = self.claim()
            answer_path.write_text(json.dumps(chatgpt_answer()))
            session.responses["/ai/worker/deep-analysis-config/"] = FakeResponse({}, status=404)
            session.posts.clear()
            with self.assertRaises(bridge_module.BridgeError):
                if command == "submit":
                    bridge.submit(41, answer_path)
                else:
                    bridge.fail(41, "분석 도구 연결 실패")
            self.assertEqual(session.posts, [])

    def test_lease_loss_is_recorded_and_not_retried(self):
        bridge, session, answer_path = self.claim({"/ai/jobs/41/complete/": FakeResponse({}, status=403)})
        answer_path.write_text(json.dumps(chatgpt_answer()))
        with self.assertRaisesRegex(bridge_module.BridgeError, "lease is no longer valid"):
            bridge.submit(41, answer_path)
        self.assertEqual(bridge.status()["running_jobs"], [])
        with self.assertRaisesRegex(bridge_module.BridgeError, "no active claim"):
            bridge.submit(41, answer_path)
        self.assertEqual(len(session.calls("/ai/jobs/41/complete/")), 1)

    def test_status_and_validate_need_no_token_or_network(self):
        job_path = Path(self.tmp.name) / "job.json"
        answer_path = Path(self.tmp.name) / "answer.json"
        job_path.write_text(json.dumps(chatgpt_job()))
        answer_path.write_text(json.dumps(chatgpt_answer()))
        with mock.patch.object(bridge_module, "read_worker_token", side_effect=AssertionError("must not read token")), mock.patch.object(RenderClient, "get_deep_analysis_config", side_effect=AssertionError("must not call backend")), mock.patch.dict("os.environ", {"CHATGPT_BRIDGE_HOME": self.tmp.name}):
            code, result = self.run_main(["validate", str(job_path), str(answer_path)])
            self.assertEqual(code, 0)
            self.assertTrue(result["local_validation_only"])
            code, result = self.run_main(["status"])
            self.assertEqual(code, 0)
            self.assertTrue(result["local_status_only"])
            self.assertFalse(result["backend_readiness_verified"])

    def test_fail_uses_the_owned_lease_and_refuses_unknown_jobs(self):
        bridge, session, _ = self.claim()
        bridge.fail(41, "분석을 완료할 수 없어 확인이 필요합니다.")
        payload = session.calls("/ai/jobs/41/fail/")[0]["json"]
        self.assertEqual(payload["model_name"], "chatgpt")
        self.assertEqual(payload["claim_timestamp"], chatgpt_job()["claimed_at"])
        with self.assertRaises(bridge_module.BridgeError):
            bridge.fail(42, "unknown")
        self.assertEqual(session.calls("/ai/jobs/42/fail/"), [])

    def test_config_does_not_reuse_legacy_worker_identity_or_home(self):
        config = bridge_module.BridgeConfig.from_env({"WORKER_NAME": "local-qwen", "CLAUDE_BRIDGE_HOME": "/tmp/claude"})
        self.assertEqual(config.worker_name, "mac-studio-chatgpt-desktop")
        self.assertNotEqual(config.bridge_home, Path("/tmp/claude"))
        config = bridge_module.BridgeConfig.from_env({"CHATGPT_WORKER_NAME": "custom-chatgpt", "CHATGPT_BRIDGE_HOME": "/tmp/custom"})
        self.assertEqual(config.worker_name, "custom-chatgpt")
        self.assertEqual(config.bridge_home, Path("/tmp/custom"))


if __name__ == "__main__":
    unittest.main()
