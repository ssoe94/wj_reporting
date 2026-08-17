from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch


TOOL_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOL_DIR))

from archive_core import (  # noqa: E402
    ArchiveIntegrityError,
    ArchiveLayout,
    DriveUnavailable,
    SourceValidationError,
    StagedBlob,
    _validate_image_content,
    apply_plan,
    build_plan,
    dry_run_summary,
    fetch_cloudinary_to_staging,
    initialize_layout,
    object_relative_path,
    validate_cloudinary_quality_url,
    validate_layout,
    verify_archive,
)
from quality_media_archive import build_parser  # noqa: E402


JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"remote-test-image"
CLOUDINARY_URL = (
    "https://res.cloudinary.com/demo/image/upload/v1720000000/quality/report-1.jpg"
)


class QualityMediaArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        temporary_root = Path(self.temporary.name)
        self.mount = temporary_root / "Ted_SSD"
        self.mount.mkdir()
        self.root = self.mount / "WJ_DATA_CENTER" / "quality_media_archive"
        self.layout = ArchiveLayout(
            root=self.root,
            mount_root=self.mount,
            require_mount=False,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_report_export(self, *, next_page: str | None = None) -> Path:
        path = Path(self.temporary.name) / "quality-reports.json"
        path.write_text(
            json.dumps(
                {
                    "count": 1,
                    "next": next_page,
                    "previous": None,
                    "results": [
                        {
                            "id": 17,
                            "updated_at": "2026-08-14T08:00:00+08:00",
                            "image1": CLOUDINARY_URL,
                            "image2": None,
                            "image3": None,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        return path

    @staticmethod
    def fake_remote_fetcher(candidate, staging: Path) -> StagedBlob:
        fd, temporary_name = tempfile.mkstemp(prefix="archive-", suffix=".part", dir=staging)
        with os.fdopen(fd, "wb") as handle:
            handle.write(JPEG_BYTES)
            handle.flush()
            os.fsync(handle.fileno())
        return StagedBlob(
            path=Path(temporary_name),
            sha256=hashlib.sha256(JPEG_BYTES).hexdigest(),
            byte_size=len(JPEG_BYTES),
            media_type="image/jpeg",
            retrieval={"http_etag": '"test-etag"'},
        )

    def test_dry_run_does_not_create_root_or_download(self) -> None:
        export_path = self.write_report_export()
        plan = build_plan(report_exports=[export_path])

        result = dry_run_summary(plan, self.layout)

        self.assertEqual(result["status"], "dry_run")
        self.assertFalse(result["network_accessed"])
        self.assertFalse(result["filesystem_written"])
        self.assertEqual(result["candidate_count"], 1)
        self.assertFalse(self.root.exists())

    def test_cli_rejects_removed_excel_archive_option(self) -> None:
        with self.assertRaises(SystemExit), patch("sys.stderr", new=io.StringIO()):
            build_parser().parse_args(
                [
                    "archive",
                    "--quality-reports-json",
                    "/tmp/reports.json",
                    "--excel",
                    "/tmp/source.xlsx",
                ]
            )

    def test_apply_archives_cloudinary_photo_with_explicit_provenance(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])

        result = apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["archived_count"], 1)
        object_hash = hashlib.sha256(JPEG_BYTES).hexdigest()
        object_path = self.root / object_relative_path(object_hash)
        self.assertEqual(object_path.read_bytes(), JPEG_BYTES)
        event_path = next((self.root / "manifests" / "items").rglob("*.json"))
        event = json.loads(event_path.read_text(encoding="utf-8"))
        self.assertEqual(event["source"]["source_entity"], "quality.QualityReport")
        self.assertEqual(event["source"]["source_entity_id"], "17")
        self.assertEqual(event["source"]["source_field"], "image1")
        self.assertEqual(event["source"]["delivery_url"], CLOUDINARY_URL)
        self.assertEqual(event["source"]["approval_state"], "not_modeled_in_current_schema")
        self.assertEqual(event["retrieval"]["http_etag"], '"test-etag"')

    def test_verify_detects_tampered_object(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)
        object_file = next(path for path in (self.root / "objects" / "sha256").rglob("*") if path.is_file())
        object_file.write_bytes(b"tampered")

        result = verify_archive(self.layout)

        self.assertEqual(result["status"], "integrity_error")
        self.assertGreater(result["error_count"], 0)

    def test_verify_detects_tampered_event_manifest_metadata(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)
        event_path = next((self.root / "manifests" / "items").rglob("*.json"))
        event = json.loads(event_path.read_text(encoding="utf-8"))
        event["media_type"] = "application/tampered"
        event_path.write_text(json.dumps(event), encoding="utf-8")

        result = verify_archive(self.layout)

        self.assertEqual(result["status"], "integrity_error")
        self.assertTrue(any("self-check" in error for error in result["errors"]))

    def test_verify_detects_tampered_run_manifest(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)
        run_path = next((self.root / "manifests" / "runs").glob("*.jsonl"))
        content = run_path.read_text(encoding="utf-8")
        run_path.write_text(
            content.replace("cloudinary_quality_photo", "cloudinary_tampered", 1),
            encoding="utf-8",
        )

        result = verify_archive(self.layout)

        self.assertEqual(result["status"], "integrity_error")
        self.assertTrue(any("run manifest self-check" in error for error in result["errors"]))

    def test_verify_accepts_untampered_archive(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)

        result = verify_archive(self.layout)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["event_manifest_count"], 1)
        self.assertEqual(result["verified_object_count"], 1)

    def test_verify_ignores_macos_metadata_sidecars_on_exfat(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)
        event_path = next((self.root / "manifests" / "items").rglob("*.json"))
        object_path = next(
            path
            for path in (self.root / "objects" / "sha256").rglob("*")
            if path.is_file()
        )
        run_path = next((self.root / "manifests" / "runs").glob("*.jsonl"))
        (event_path.parent / f"._{event_path.name}").write_bytes(b"apple-double")
        (object_path.parent / f"._{object_path.name}").write_bytes(b"apple-double")
        (run_path.parent / f"._{run_path.name}").write_bytes(b"apple-double")
        (self.root / "objects" / ".DS_Store").write_bytes(b"finder-metadata")

        result = verify_archive(self.layout)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["error_count"], 0)

    def test_interrupted_staging_file_is_recovered_under_lock(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        initialize_layout(self.layout)
        interrupted = self.layout.staging / "archive-interrupted.part"
        interrupted.write_bytes(b"partial")

        result = apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["recovered_staging_files"], 1)
        self.assertFalse(interrupted.exists())

    def test_existing_orphan_object_is_reused_and_manifested_on_rerun(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        initialize_layout(self.layout)
        object_hash = hashlib.sha256(JPEG_BYTES).hexdigest()
        relative = object_relative_path(object_hash)
        destination = self.root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(JPEG_BYTES)

        result = apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)

        self.assertGreaterEqual(result["deduplicated_count"], 1)
        self.assertEqual(verify_archive(self.layout)["status"], "ok")

    def test_cloudinary_url_allowlist_is_strict(self) -> None:
        asset_sha = "a" * 64
        managed_asset_url = (
            "https://res.cloudinary.com/demo/image/upload/v1720000000/"
            f"media/quality-import/assets/{asset_sha}"
        )
        invalid = [
            CLOUDINARY_URL.replace("https://", "http://"),
            CLOUDINARY_URL.replace("res.cloudinary.com", "example.com"),
            CLOUDINARY_URL.replace("/quality/", "/other/"),
            CLOUDINARY_URL + "?token=secret",
            "https://res.cloudinary.com/demo/raw/upload/v1/quality/file.jpg",
            managed_asset_url.replace(asset_sha, "not-a-content-hash"),
            managed_asset_url.replace("/assets/", "/other/"),
        ]
        for url in invalid:
            with self.subTest(url=url):
                with self.assertRaises(SourceValidationError):
                    validate_cloudinary_quality_url(url)
        self.assertEqual(validate_cloudinary_quality_url(CLOUDINARY_URL), CLOUDINARY_URL)
        self.assertEqual(
            validate_cloudinary_quality_url(managed_asset_url),
            managed_asset_url,
        )

    def test_archive_accepts_backend_asset_bmp_and_tiff_signatures(self) -> None:
        signatures = {
            "issue.bmp": (b"BM" + b"\x00" * 30, "image/bmp"),
            "issue-le.tiff": (b"II*\x00" + b"\x00" * 28, "image/tiff"),
            "issue-be.tiff": (b"MM\x00*" + b"\x00" * 28, "image/tiff"),
        }
        for filename, (content, expected_type) in signatures.items():
            with self.subTest(filename=filename):
                path = Path(self.temporary.name) / filename
                path.write_bytes(content)
                self.assertEqual(_validate_image_content(path), expected_type)

    def test_incomplete_paginated_export_fails_closed(self) -> None:
        path = self.write_report_export(next_page="https://example.invalid/page/2")

        with self.assertRaises(SourceValidationError):
            build_plan(report_exports=[path])

    def test_report_export_count_must_match_rows(self) -> None:
        path = self.write_report_export()
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["count"] = 2
        path.write_text(json.dumps(payload), encoding="utf-8")

        with self.assertRaises(SourceValidationError):
            build_plan(report_exports=[path])

    def test_missing_drive_fails_closed(self) -> None:
        missing = ArchiveLayout(
            root=Path(self.temporary.name) / "missing" / "archive",
            mount_root=Path(self.temporary.name) / "missing",
            require_mount=False,
        )

        with self.assertRaises(DriveUnavailable):
            validate_layout(missing, for_write=True)

    def test_non_writable_drive_fails_closed(self) -> None:
        with patch("archive_core.os.access", return_value=False):
            with self.assertRaises(DriveUnavailable):
                validate_layout(self.layout, for_write=True)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink support required")
    def test_archive_root_symlink_is_rejected(self) -> None:
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        self.root.parent.mkdir(parents=True)
        self.root.symlink_to(outside, target_is_directory=True)

        with self.assertRaises(DriveUnavailable):
            validate_layout(self.layout, for_write=True)

    def test_unexpected_staging_file_stops_recovery(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        initialize_layout(self.layout)
        (self.layout.staging / "unknown.txt").write_text("do not delete", encoding="utf-8")

        with self.assertRaises(ArchiveIntegrityError):
            apply_plan(plan, self.layout, remote_fetcher=self.fake_remote_fetcher)

    def test_default_remote_fetch_rejects_changed_response_url(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        candidate = plan.candidates[0]
        initialize_layout(self.layout)
        headers = Message()
        headers["Content-Type"] = "image/jpeg"
        headers["Content-Length"] = str(len(JPEG_BYTES))

        class FakeResponse(io.BytesIO):
            status = 200

            def __init__(self):
                super().__init__(JPEG_BYTES)
                self.headers = headers

            def geturl(self):
                return CLOUDINARY_URL.replace("/quality/", "/other/")

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                self.close()

        class FakeOpener:
            def open(self, request, timeout):
                return FakeResponse()

        with patch("archive_core._require_public_cloudinary_dns"), patch(
            "archive_core.urllib.request.build_opener", return_value=FakeOpener()
        ):
            with self.assertRaises(SourceValidationError):
                fetch_cloudinary_to_staging(candidate, self.layout.staging)

    def test_default_remote_fetch_enforces_mime_and_declared_size(self) -> None:
        plan = build_plan(report_exports=[self.write_report_export()])
        candidate = plan.candidates[0]
        initialize_layout(self.layout)

        class FakeResponse(io.BytesIO):
            status = 200

            def __init__(self, content_type: str, content_length: int):
                super().__init__(JPEG_BYTES)
                self.headers = Message()
                self.headers["Content-Type"] = content_type
                self.headers["Content-Length"] = str(content_length)

            def geturl(self):
                return CLOUDINARY_URL

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                self.close()

        class FakeOpener:
            def __init__(self, response):
                self.response = response

            def open(self, request, timeout):
                return self.response

        for response in (
            FakeResponse("text/html", len(JPEG_BYTES)),
            FakeResponse("image/jpeg", 50 * 1024 * 1024 + 1),
        ):
            with self.subTest(content_type=response.headers["Content-Type"]), patch(
                "archive_core._require_public_cloudinary_dns"
            ), patch(
                "archive_core.urllib.request.build_opener",
                return_value=FakeOpener(response),
            ):
                with self.assertRaises(SourceValidationError):
                    fetch_cloudinary_to_staging(candidate, self.layout.staging)


if __name__ == "__main__":
    unittest.main()
