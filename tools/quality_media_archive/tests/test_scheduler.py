from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock


TOOL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_DIR))

import scheduler  # noqa: E402


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, maximum):
        return self.payload[:maximum]


class FakeOpener:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return FakeResponse(self.payload)


class SchedulerTests(unittest.TestCase):
    def test_keychain_implementation_never_invokes_security_cli_with_token_argv(self):
        self.assertFalse(hasattr(scheduler, "subprocess"))

    def test_token_request_requires_rotated_refresh_and_never_echoes_credentials(self):
        opener = FakeOpener({"access": "access-value", "refresh": "rotated-value"})

        result = scheduler.request_token_pair(
            "https://wj-reporting.example",
            payload={"refresh": "old-secret"},
            endpoint_suffix="refresh/",
            opener=opener,
        )

        self.assertEqual(result, {"access": "access-value", "refresh": "rotated-value"})
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "https://wj-reporting.example/api/token/refresh/")
        self.assertEqual(timeout, scheduler.HTTP_TIMEOUT_SECONDS)

    def test_sync_rotates_keychain_before_archive_work(self):
        calls = []
        with (
            mock.patch.object(scheduler, "api_base_url", return_value="https://wj-reporting.example"),
            mock.patch.object(scheduler, "keychain_identity", return_value=("service", "account")),
            mock.patch.object(scheduler, "keychain_read_refresh_token", return_value="old-refresh"),
            mock.patch.object(
                scheduler,
                "request_token_pair",
                return_value={"access": "new-access", "refresh": "new-refresh"},
            ),
            mock.patch.object(
                scheduler,
                "keychain_store_refresh_token",
                side_effect=lambda *_args, **_kwargs: calls.append("stored"),
            ),
            mock.patch.object(
                scheduler,
                "run_api_sync",
                side_effect=lambda *_args, **_kwargs: calls.append("synced") or {"status": "ok"},
            ),
        ):
            result = scheduler.sync_once()

        self.assertEqual(calls, ["stored", "synced"])
        self.assertEqual(result["credential_rotation"], "completed")

    def test_status_reports_only_credential_presence_not_value(self):
        with (
            mock.patch.object(scheduler, "keychain_identity", return_value=("service", "account")),
            mock.patch.object(scheduler, "keychain_has_refresh_token", return_value=True),
            mock.patch.object(scheduler, "api_base_url", return_value="https://wj-reporting.example"),
            mock.patch.object(Path, "is_dir", return_value=True),
            mock.patch.object(scheduler.os, "access", return_value=True),
        ):
            result = scheduler.status()

        self.assertTrue(result["refresh_credential_present"])
        self.assertNotIn("token", " ".join(result.keys()).lower().replace("refresh_credential_present", ""))

    def test_main_redacts_rejected_password(self):
        output = io.StringIO()
        with (
            mock.patch.object(scheduler, "configure", side_effect=scheduler.SchedulerError("credential was rejected")),
            mock.patch("sys.stdout", output),
        ):
            code = scheduler.main(["configure", "--username", "tester"])

        self.assertEqual(code, 1)
        self.assertNotIn("password", output.getvalue().lower())


if __name__ == "__main__":
    unittest.main()
