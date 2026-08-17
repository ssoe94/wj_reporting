from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path
from unittest import mock


TOOL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_DIR))

from api_sync import (  # noqa: E402
    API_BASE_URL_ENV,
    API_BEARER_TOKEN_ENV,
    AuthenticatedApiTransport,
    SourceValidationError,
    api_sync_dry_run,
    collect_api_snapshot,
    read_api_configuration,
    run_api_sync,
    validate_api_base_url,
)
from archive_core import (  # noqa: E402
    ArchiveLayout,
    StagedBlob,
    object_relative_path,
)


BASE_URL = "https://wj-reporting.example"
CLOUDINARY_URL = (
    "https://res.cloudinary.com/demo/image/upload/v1720000000/quality/report-1.jpg"
)
JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"cloudinary-report"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"embedded-media"


class FakeTransport:
    def __init__(self, *, wrong_media_bytes: bool = False, incomplete_reports: bool = False):
        self.calls: list[tuple[str, str]] = []
        self.posts: list[tuple[str, dict]] = []
        self.wrong_media_bytes = wrong_media_bytes
        self.incomplete_reports = incomplete_reports
        self.media_sha = hashlib.sha256(PNG_BYTES).hexdigest()

    def get_json(self, url: str):
        self.calls.append(("GET", url))
        parsed = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parsed.query)
        page = query.get("page", ["1"])[0]
        if parsed.path == "/api/quality/reports/":
            if page == "1":
                return {
                    "count": 2,
                    "next": None
                    if self.incomplete_reports
                    else f"{BASE_URL}/api/quality/reports/?page=2&page_size=200",
                    "previous": None,
                    "results": [
                        {
                            "id": 10,
                            "updated_at": "2026-08-14T08:00:00+08:00",
                            "image1": CLOUDINARY_URL,
                            "image2": None,
                            "image3": None,
                        }
                    ],
                }
            return {
                "count": 2,
                "next": None,
                "previous": f"{BASE_URL}/api/quality/reports/?page=1&page_size=200",
                "results": [
                    {
                        "id": 11,
                        "updated_at": "2026-08-14T09:00:00+08:00",
                        "image1": None,
                        "image2": None,
                        "image3": None,
                    }
                ],
            }
        if parsed.path == "/api/quality/import-assets/":
            self.assert_pending_query(query)
            return {
                "count": 1,
                "next": None,
                "previous": None,
                "results": [
                    {
                        "id": 31,
                        "content_type": "image/png",
                        "byte_size": len(PNG_BYTES),
                        "sha256": self.media_sha,
                        "extension": "png",
                        "width": 16,
                        "height": 8,
                        "mirror_state": "pending",
                        "mirrored_at": None,
                        "url": f"{BASE_URL}/api/quality/import-assets/31/content/",
                        "created_at": "2026-08-14T09:30:00+08:00",
                    }
                ],
            }
        raise AssertionError(f"unexpected GET URL: {url}")

    @staticmethod
    def assert_pending_query(query):
        if query.get("mirror_state") != ["pending"]:
            raise AssertionError("pending filter missing")

    def fetch_to_staging(self, candidate, staging: Path) -> StagedBlob:
        self.calls.append(("DOWNLOAD", candidate.remote_url or ""))
        if candidate.label.startswith("quality_report:"):
            content, media_type = JPEG_BYTES, "image/jpeg"
        else:
            content = b"wrong" if self.wrong_media_bytes else PNG_BYTES
            media_type = "image/png"
        descriptor, temporary_name = tempfile.mkstemp(
            prefix="archive-", suffix=".part", dir=staging
        )
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        return StagedBlob(
            path=Path(temporary_name),
            sha256=hashlib.sha256(content).hexdigest(),
            byte_size=len(content),
            media_type=media_type,
            retrieval={"http_content_type": media_type},
        )

    def post_json(self, url: str, payload):
        self.calls.append(("POST", url))
        self.posts.append((url, dict(payload)))
        return {
            "mirror_state": "mirrored",
            "archive_relative_path": payload["archive_relative_path"],
            "sha256": payload["sha256"],
        }


class _JsonHeaders:
    def __init__(self, size: int):
        self._size = size

    def get(self, key, default=None):
        if key == "Content-Length":
            return str(self._size)
        return default

    @staticmethod
    def get_content_type():
        return "application/json"


class _JsonResponse:
    status = 200

    def __init__(self, url: str, payload: dict):
        self._url = url
        self._body = json.dumps(payload).encode("utf-8")
        self.headers = _JsonHeaders(len(self._body))

    def geturl(self):
        return self._url

    def read(self, limit):
        return self._body[:limit]

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
        return False


class _UnauthorizedThenOkOpener:
    def __init__(self, url: str):
        self.url = url
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if len(self.requests) == 1:
            raise urllib.error.HTTPError(self.url, 401, "expired", {}, None)
        return _JsonResponse(self.url, {"ok": True})


class QualityApiSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.mount = Path(self.temporary.name) / "Ted_SSD"
        self.mount.mkdir()
        self.root = self.mount / "WJ_DATA_CENTER" / "quality_media_archive"
        self.layout = ArchiveLayout(
            root=self.root,
            mount_root=self.mount,
            require_mount=False,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_dry_run_reads_no_environment_and_performs_no_network_or_write(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            result = api_sync_dry_run(self.layout)

        self.assertEqual(result["status"], "dry_run")
        self.assertFalse(result["network_accessed"])
        self.assertFalse(result["filesystem_written"])
        self.assertFalse(self.root.exists())
        self.assertEqual(
            result["configuration_env"], [API_BASE_URL_ENV, API_BEARER_TOKEN_ENV]
        )
        self.assertEqual(
            result["planned_endpoints"],
            [
                "/api/quality/reports/",
                "/api/quality/import-assets/?mirror_state=pending",
            ],
        )
        self.assertFalse(any("import-batches" in path for path in result["planned_endpoints"]))

    def test_snapshot_paginates_reports_and_unique_assets_before_archive(self) -> None:
        transport = FakeTransport()

        snapshot = collect_api_snapshot(transport, BASE_URL)

        self.assertEqual(snapshot.report_count, 2)
        self.assertEqual(snapshot.pending_asset_count, 1)
        self.assertEqual(len(snapshot.plan.candidates), 2)
        self.assertEqual(set(snapshot.marks), {"quality_import_asset:31"})
        media_candidate = next(
            item for item in snapshot.plan.candidates
            if item.label == "quality_import_asset:31"
        )
        self.assertNotIn("storage_key", media_candidate.source)
        self.assertTrue(any("page=2" in url for method, url in transport.calls if method == "GET"))

    def test_apply_archives_reports_and_unique_assets_then_marks_assets(self) -> None:
        transport = FakeTransport()

        result = run_api_sync(self.layout, base_url=BASE_URL, transport=transport)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["marked_mirrored_count"], 1)
        self.assertEqual(len(transport.posts), 1)
        for _, payload in transport.posts:
            object_path = self.root / payload["archive_relative_path"]
            self.assertTrue(object_path.is_file())
            self.assertEqual(hashlib.sha256(object_path.read_bytes()).hexdigest(), payload["sha256"])
            self.assertEqual(
                payload["archive_relative_path"], object_relative_path(payload["sha256"]).as_posix()
            )
        manifest_text = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (self.root / "manifests").rglob("*")
            if path.is_file() and path.suffix in {".json", ".jsonl"}
        )
        self.assertIn("quality_report_api_current_cloudinary_reference", manifest_text)
        self.assertIn("quality_import_api_asset", manifest_text)
        self.assertNotIn("quality_import_source", manifest_text)

    def test_second_daily_sync_uses_verified_local_objects_without_redownloading(self) -> None:
        first_transport = FakeTransport()
        run_api_sync(self.layout, base_url=BASE_URL, transport=first_transport)
        second_transport = FakeTransport()

        result = run_api_sync(self.layout, base_url=BASE_URL, transport=second_transport)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["already_archived_count"], 2)
        self.assertEqual(result["archived_count"], 0)
        self.assertFalse(any(method == "DOWNLOAD" for method, _ in second_transport.calls))
        self.assertEqual(result["marked_mirrored_count"], 1)

    def test_checksum_failure_is_not_acknowledged(self) -> None:
        transport = FakeTransport(wrong_media_bytes=True)

        result = run_api_sync(self.layout, base_url=BASE_URL, transport=transport)

        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["marked_mirrored_count"], 0)
        self.assertFalse(any("/import-assets/31/mark-mirrored/" in url for url, _ in transport.posts))
        self.assertTrue(any(item["source_label"] == "quality_import_asset:31" for item in result["failures"]))

    def test_incomplete_pagination_fails_before_archive_root_exists(self) -> None:
        transport = FakeTransport(incomplete_reports=True)

        with self.assertRaises(SourceValidationError):
            run_api_sync(self.layout, base_url=BASE_URL, transport=transport)

        self.assertFalse(self.root.exists())
        self.assertEqual(transport.posts, [])

    def test_configuration_is_environment_only_and_token_is_redacted_from_validation(self) -> None:
        token = "secret-token-that-must-not-be-printed"
        base_url, loaded = read_api_configuration(
            {API_BASE_URL_ENV: BASE_URL, API_BEARER_TOKEN_ENV: token}
        )
        self.assertEqual(base_url, BASE_URL)
        self.assertEqual(loaded, token)
        with self.assertRaises(SourceValidationError) as context:
            read_api_configuration(
                {API_BASE_URL_ENV: BASE_URL, API_BEARER_TOKEN_ENV: "bad token"}
            )
        self.assertNotIn("bad token", str(context.exception))

    def test_base_url_rejects_non_https_paths_and_credentials(self) -> None:
        invalid = [
            "http://wj-reporting.example",
            "https://user:password@wj-reporting.example",
            "https://wj-reporting.example/api/",
            "https://wj-reporting.example?token=secret",
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(SourceValidationError):
                validate_api_base_url(value)

    def test_authenticated_transport_refreshes_once_after_access_expiry(self) -> None:
        url = f"{BASE_URL}/api/quality/reports/?page_size=200"
        refreshed = []
        opener = _UnauthorizedThenOkOpener(url)
        transport = AuthenticatedApiTransport(
            BASE_URL,
            "old-access",
            refresh_access_token=lambda: refreshed.append(True) or "new-access",
        )
        transport._dns_checked = True
        transport._opener = opener

        result = transport.get_json(url)

        self.assertEqual(result, {"ok": True})
        self.assertEqual(refreshed, [True])
        self.assertEqual(
            [request.get_header("Authorization") for request, _ in opener.requests],
            ["Bearer old-access", "Bearer new-access"],
        )


if __name__ == "__main__":
    unittest.main()
