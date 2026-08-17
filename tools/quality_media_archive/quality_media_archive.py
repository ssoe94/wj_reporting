#!/usr/bin/env python3
"""CLI for the fixed Ted_SSD quality media archive."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

try:
    from .archive_core import (
        FIXED_ARCHIVE_ROOT,
        ArchiveError,
        ArchiveLayout,
        apply_plan,
        build_plan,
        drive_status,
        dry_run_summary,
        verify_archive,
    )
    from .api_sync import (
        AuthenticatedApiTransport,
        api_sync_dry_run,
        read_api_configuration,
        run_api_sync,
    )
except ImportError:
    from archive_core import (
        FIXED_ARCHIVE_ROOT,
        ArchiveError,
        ArchiveLayout,
        apply_plan,
        build_plan,
        drive_status,
        dry_run_summary,
        verify_archive,
    )
    from api_sync import (
        AuthenticatedApiTransport,
        api_sync_dry_run,
        read_api_configuration,
        run_api_sync,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Archive current QualityReport Cloudinary references and normalized import assets "
            f"to {FIXED_ARCHIVE_ROOT}. Archive mode is dry-run unless --apply is supplied."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    archive_parser = subparsers.add_parser(
        "archive",
        help="plan or apply an archive tranche; defaults to no-write/no-network dry-run",
    )
    archive_parser.add_argument(
        "--quality-reports-json",
        type=Path,
        action="append",
        default=[],
        help="complete current QualityReport JSON export; may be repeated",
    )
    archive_parser.add_argument(
        "--apply",
        action="store_true",
        help="perform downloads and local writes; omitted means dry-run",
    )

    sync_parser = subparsers.add_parser(
        "sync",
        help="sync complete quality API pages to Ted_SSD; defaults to no-network dry-run",
    )
    sync_parser.add_argument(
        "--apply",
        action="store_true",
        help="read API configuration from environment, download, archive, then acknowledge mirrors",
    )

    subparsers.add_parser("status", help="check the fixed drive/root contract without writing")
    subparsers.add_parser("verify", help="hash every manifested object and check archive integrity")
    return parser


def error_payload(exc: Exception) -> dict[str, Any]:
    return {
        "schema_version": "quality-media-archive.v1",
        "status": "error",
        "archive_root": str(FIXED_ARCHIVE_ROOT),
        "error_type": type(exc).__name__,
        "message": str(exc),
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    layout = ArchiveLayout()
    try:
        if args.command == "status":
            result = drive_status(layout)
        elif args.command == "verify":
            result = verify_archive(layout)
        elif args.command == "archive":
            if not args.quality_reports_json:
                raise ArchiveError("archive requires --quality-reports-json")
            plan = build_plan(report_exports=args.quality_reports_json)
            if not plan.candidates:
                raise ArchiveError("no eligible archive candidates were found")
            result = apply_plan(plan, layout) if args.apply else dry_run_summary(plan, layout)
        elif args.command == "sync":
            if not args.apply:
                result = api_sync_dry_run(layout)
            else:
                base_url, token = read_api_configuration()
                result = run_api_sync(
                    layout,
                    base_url=base_url,
                    transport=AuthenticatedApiTransport(base_url, token),
                )
        else:  # pragma: no cover - argparse enforces known commands.
            raise ArchiveError(f"unsupported command: {args.command}")
    except (ArchiveError, OSError) as exc:
        result = error_payload(exc)

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result.get("status") in {"ready", "dry_run", "ok"} else 1


if __name__ == "__main__":
    sys.exit(main())
