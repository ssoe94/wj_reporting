from __future__ import annotations

import hashlib
import math
import re
import uuid
import zipfile
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any, Iterable

import cloudinary.uploader
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from injection.models import MouldDataSnapshot
from quality.daily_attention import build_daily_quality_attention

from .ai_metrics import SHANGHAI_TZ
from .ai_retrievers import (
    get_injection_machine_shot_context,
    get_injection_summary,
    machine_label,
    machine_monitoring_name,
    parse_machine_number,
)
from .models import InjectionDowntimeConfirmation, ProductionPlan


FIELD_MATERIALS_SNAPSHOT_KEY = "field-materials-v1"
FIELD_MATERIALS_SCHEMA = "field-materials.v1"
FIELD_DEFECTS_SCHEMA = "field-defects.v1"
FIELD_KANBAN_SCHEMA = "field-kanban.v1"
MAX_DOCUMENT_BYTES = 30 * 1024 * 1024

DOCUMENT_KINDS = {"work_instruction", "drawing"}
SOURCE_EXTENSIONS = {"pdf", "ppt", "pptx"}
MATERIAL_MATCH_EXACT = "exact"
MATERIAL_MATCH_PART_FAMILY_LAST_TWO = "part_family_last_two"
MATERIAL_MATCH_RULES = {
    MATERIAL_MATCH_EXACT,
    MATERIAL_MATCH_PART_FAMILY_LAST_TWO,
}

DEFECT_TYPES = [
    {"code": "scratch", "label": {"zh": "划伤", "ko": "스크래치"}},
    {"code": "black_dot", "label": {"zh": "黑点", "ko": "흑점"}},
    {"code": "eaten_meat", "label": {"zh": "吃肉", "ko": "파먹음"}},
    {"code": "air_mark", "label": {"zh": "气印", "ko": "에어마크"}},
    {"code": "deform", "label": {"zh": "变形", "ko": "변형"}},
    {"code": "short_shot", "label": {"zh": "缺胶", "ko": "미성형"}},
    {"code": "broken_pillar", "label": {"zh": "断柱子", "ko": "기둥파손"}},
    {"code": "flow_mark", "label": {"zh": "流痕", "ko": "플로우마크"}},
    {"code": "sink_mark", "label": {"zh": "缩印", "ko": "수축"}},
    {"code": "whitening", "label": {"zh": "发白", "ko": "백화"}},
    {"code": "other", "label": {"zh": "其他", "ko": "기타"}},
]
DEFECT_CODES = {row["code"] for row in DEFECT_TYPES}

QUALITY_DISCLAIMER = {
    "zh": "仅为与当前计划料号关联的历史品质记录，不代表当前正在发生不良。",
    "ko": "현재 계획 품번과 연결된 과거 품질 이력이며, 현재 불량 발생을 의미하지 않습니다.",
}


class FieldKanbanError(ValueError):
    def __init__(self, detail: str, *, code: str = "invalid_request", status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.code = code
        self.status_code = status_code


def normalize_part_no(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "")).upper()


def normalize_model_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).upper()


def material_part_family_key(value: Any) -> str:
    """Return the part scope shared by variants in the final two positions."""
    normalized = normalize_part_no(value)
    return normalized[:-2] if len(normalized) > 2 else ""


def material_parts_share_family(left: Any, right: Any) -> bool:
    normalized_left = normalize_part_no(left)
    normalized_right = normalize_part_no(right)
    return bool(
        len(normalized_left) >= 3
        and len(normalized_left) == len(normalized_right)
        and normalized_left[:-2] == normalized_right[:-2]
    )


def _material_match_rule(value: Any, *, strict: bool = False) -> str:
    normalized = str(value or MATERIAL_MATCH_EXACT).strip().lower()
    if normalized in MATERIAL_MATCH_RULES:
        return normalized
    if strict:
        raise FieldKanbanError(
            "match_rule must be exact or part_family_last_two.",
            code="invalid_material_match_rule",
        )
    return MATERIAL_MATCH_EXACT


def current_shanghai_business_date(now: datetime | None = None) -> date:
    local_now = (now or timezone.now()).astimezone(SHANGHAI_TZ)
    return (local_now - timedelta(hours=8)).date()


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _clean_filename(value: Any) -> str:
    filename = Path(str(value or "document")).name
    filename = re.sub(r"[\x00-\x1f\x7f]+", "", filename).strip()
    return (filename or "document")[:180]


def _material_manifest_payload() -> dict[str, Any]:
    return {
        "schema_version": FIELD_MATERIALS_SCHEMA,
        "documents": [],
    }


def _validate_material_manifest(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise FieldKanbanError(
            "Stored field-material manifest is invalid.",
            code="invalid_material_manifest",
            status_code=409,
        )
    if payload.get("schema_version") != FIELD_MATERIALS_SCHEMA:
        raise FieldKanbanError(
            "Stored field-material manifest version is not supported.",
            code="unsupported_material_manifest",
            status_code=409,
        )
    if not isinstance(payload.get("documents"), list):
        raise FieldKanbanError(
            "Stored field-material document list is invalid.",
            code="invalid_material_manifest",
            status_code=409,
        )
    return payload


def load_material_documents() -> list[dict[str, Any]]:
    snapshot = MouldDataSnapshot.objects.filter(
        snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
    ).first()
    if snapshot is None:
        return []
    payload = _validate_material_manifest(snapshot.payload)
    return [row for row in payload["documents"] if isinstance(row, dict)]


def _document_sort_key(document: dict[str, Any]) -> tuple[str, str]:
    return (str(document.get("uploaded_at") or ""), str(document.get("id") or ""))


def serialize_document(document: dict[str, Any] | None) -> dict[str, Any] | None:
    if not document:
        return None
    preview = document.get("preview") if isinstance(document.get("preview"), dict) else None
    source = document.get("source") if isinstance(document.get("source"), dict) else {}
    return {
        "id": document.get("id"),
        "kind": document.get("kind"),
        "part_no": document.get("part_no") or "",
        "model_name": document.get("model_name") or "",
        "revision": document.get("revision") or "",
        "match_rule": _material_match_rule(document.get("match_rule")),
        "source_format": source.get("format"),
        "source_url": source.get("url"),
        "source_file_name": source.get("file_name"),
        "preview_url": preview.get("url") if preview else None,
        "preview_format": preview.get("format") if preview else None,
        "ready": bool(preview and preview.get("url")),
        "uploaded_at": document.get("uploaded_at"),
        "uploaded_by": document.get("uploaded_by"),
    }


def resolve_material_documents(
    part_no: Any,
    model_name: Any,
    *,
    documents: Iterable[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any] | None]:
    normalized_part = normalize_part_no(part_no)
    normalized_model = normalize_model_name(model_name)
    source = list(documents if documents is not None else load_material_documents())
    active = [row for row in source if row.get("active", True)]

    normalized_family = material_part_family_key(normalized_part)

    def candidates(kind: str) -> list[tuple[int, str, dict[str, Any]]]:
        ranked: list[tuple[int, str, dict[str, Any]]] = []
        for row in active:
            if row.get("kind") != kind:
                continue
            row_part = normalize_part_no(row.get("part_no"))
            row_model = normalize_model_name(row.get("model_name"))
            row_match_rule = _material_match_rule(row.get("match_rule"))
            if (
                row_match_rule == MATERIAL_MATCH_EXACT
                and normalized_part
                and row_part == normalized_part
            ):
                rank = 0 if normalized_model and row_model == normalized_model else 1
                match_basis = MATERIAL_MATCH_EXACT
            elif (
                normalized_family
                and row_match_rule == MATERIAL_MATCH_PART_FAMILY_LAST_TWO
                and material_parts_share_family(row_part, normalized_part)
                and row_model == normalized_model
            ):
                rank = 2 if normalized_model and row_model == normalized_model else 3
                match_basis = MATERIAL_MATCH_PART_FAMILY_LAST_TWO
            elif normalized_model and not row_part and row_model == normalized_model:
                if kind == "drawing":
                    continue
                rank = 4
                match_basis = "model"
            else:
                continue
            ranked.append((rank, match_basis, row))
        return ranked

    resolved: dict[str, dict[str, Any] | None] = {}
    for kind in ("work_instruction", "drawing"):
        ranked = candidates(kind)
        if not ranked:
            resolved[kind] = None
            continue
        best_rank = min(rank for rank, _basis, _row in ranked)
        best_basis, best = max(
            ((basis, row) for rank, basis, row in ranked if rank == best_rank),
            key=lambda item: _document_sort_key(item[1]),
        )
        serialized = serialize_document(best)
        if serialized is not None:
            serialized["match_basis"] = best_basis
            serialized["matched_from_part_no"] = normalize_part_no(best.get("part_no"))
        resolved[kind] = serialized
    return resolved


def _validate_upload(uploaded: Any, *, allowed_extensions: set[str]) -> tuple[str, str]:
    if uploaded is None:
        raise FieldKanbanError("A document file is required.", code="file_required")
    size = _safe_int(getattr(uploaded, "size", 0))
    if size <= 0:
        raise FieldKanbanError("The uploaded file is empty.", code="empty_file")
    if size > MAX_DOCUMENT_BYTES:
        raise FieldKanbanError(
            "The uploaded file exceeds the 30 MB limit.",
            code="file_too_large",
            status_code=413,
        )

    filename = _clean_filename(getattr(uploaded, "name", "document"))
    extension = Path(filename).suffix.lower().lstrip(".")
    if extension not in allowed_extensions:
        raise FieldKanbanError(
            f"Unsupported document format: {extension or 'unknown'}.",
            code="unsupported_file_format",
        )

    try:
        uploaded.seek(0)
        header = uploaded.read(512)
        uploaded.seek(0)
    except Exception as exc:
        raise FieldKanbanError("The uploaded file cannot be read.", code="unreadable_file") from exc

    if extension == "pdf" and not header.startswith(b"%PDF-"):
        raise FieldKanbanError("The file content is not a PDF.", code="invalid_pdf")
    if extension == "ppt":
        valid_ole_header = bool(
            len(header) >= 512
            and header.startswith(bytes.fromhex("d0cf11e0a1b11ae1"))
            and header[28:30] == bytes.fromhex("feff")
            and int.from_bytes(header[26:28], "little") in {3, 4}
            and int.from_bytes(header[30:32], "little") in {9, 12}
            and int.from_bytes(header[32:34], "little") == 6
        )
        if not valid_ole_header:
            raise FieldKanbanError("The file content is not a PowerPoint document.", code="invalid_ppt")
    if extension == "pptx":
        if not header.startswith(b"PK"):
            raise FieldKanbanError("The file content is not a PowerPoint document.", code="invalid_pptx")
        try:
            with zipfile.ZipFile(uploaded) as archive:
                names = archive.namelist()
                if "[Content_Types].xml" not in names or not any(name.startswith("ppt/") for name in names):
                    raise FieldKanbanError(
                        "The file content is not a PowerPoint document.",
                        code="invalid_pptx",
                    )
        except zipfile.BadZipFile as exc:
            raise FieldKanbanError(
                "The file content is not a PowerPoint document.",
                code="invalid_pptx",
            ) from exc
        finally:
            uploaded.seek(0)
    return extension, filename


def _file_sha256(uploaded: Any) -> str:
    digest = hashlib.sha256()
    uploaded.seek(0)
    chunks = uploaded.chunks() if hasattr(uploaded, "chunks") else iter(lambda: uploaded.read(1024 * 1024), b"")
    for chunk in chunks:
        digest.update(chunk)
    uploaded.seek(0)
    return digest.hexdigest()


def _upload_field_document(uploaded: Any, *, kind: str, extension: str, filename: str) -> dict[str, Any]:
    sha256 = _file_sha256(uploaded)
    month = timezone.now().astimezone(SHANGHAI_TZ).strftime("%Y-%m")
    public_id = f"wj-field-materials/{kind}/{month}/{uuid.uuid4().hex}.{extension}"
    try:
        response = cloudinary.uploader.upload(
            uploaded,
            resource_type="raw",
            public_id=public_id,
            overwrite=False,
            unique_filename=False,
            use_filename=False,
        )
    except Exception as exc:
        # The upload API can time out after Cloudinary has already accepted the
        # object. The client-generated public id is known even when no response
        # arrives, so make a best-effort delete before surfacing the failure.
        _cleanup_uploaded_documents([{
            "public_id": public_id,
            "resource_type": "raw",
        }])
        raise FieldKanbanError(
            "The document storage service is unavailable.",
            code="document_storage_unavailable",
            status_code=503,
        ) from exc
    finally:
        uploaded.seek(0)

    secure_url = str(response.get("secure_url") or "").strip()
    if not secure_url:
        _cleanup_uploaded_documents([{
            "public_id": response.get("public_id") or public_id,
            "resource_type": response.get("resource_type") or "raw",
        }])
        raise FieldKanbanError(
            "The document storage service returned no file URL.",
            code="document_storage_invalid_response",
            status_code=502,
        )
    return {
        "url": secure_url,
        "public_id": response.get("public_id") or public_id,
        "resource_type": response.get("resource_type") or "raw",
        "format": extension,
        "bytes": _safe_int(response.get("bytes"), _safe_int(getattr(uploaded, "size", 0))),
        "sha256": sha256,
        "file_name": filename,
        "content_type": str(getattr(uploaded, "content_type", "") or ""),
    }


def _cleanup_uploaded_documents(assets: Iterable[dict[str, Any]]) -> None:
    """Best-effort rollback for objects created by the current failed request."""
    for asset in assets:
        public_id = str(asset.get("public_id") or "").strip()
        if not public_id:
            continue
        try:
            cloudinary.uploader.destroy(
                public_id,
                resource_type="raw",
                invalidate=True,
            )
        except Exception:
            # The API request must still fail with its original validation or
            # persistence error. An orphan can be reconciled from Cloudinary's
            # upload audit rather than hiding the primary failure.
            pass


def save_field_material(
    *,
    kind: Any,
    part_no: Any,
    model_name: Any,
    revision: Any,
    source_file: Any,
    preview_pdf: Any,
    user: Any,
    match_rule: Any = MATERIAL_MATCH_EXACT,
) -> dict[str, Any]:
    normalized_kind = str(kind or "").strip()
    if normalized_kind not in DOCUMENT_KINDS:
        raise FieldKanbanError("kind must be work_instruction or drawing.", code="invalid_document_kind")
    normalized_part = normalize_part_no(part_no)
    normalized_model = str(model_name or "").strip()
    normalized_match_rule = _material_match_rule(match_rule, strict=True)
    if not normalized_part and not normalized_model:
        raise FieldKanbanError("part_no or model_name is required.", code="document_scope_required")
    if normalized_kind == "drawing" and not normalized_part:
        raise FieldKanbanError("A drawing must be matched to a part number.", code="drawing_part_required")
    if normalized_match_rule == MATERIAL_MATCH_PART_FAMILY_LAST_TWO and not material_part_family_key(normalized_part):
        raise FieldKanbanError(
            "part_family_last_two requires a part number with at least three characters.",
            code="material_part_family_required",
        )
    if normalized_match_rule == MATERIAL_MATCH_PART_FAMILY_LAST_TWO and not normalize_model_name(normalized_model):
        raise FieldKanbanError(
            "part_family_last_two requires a model name.",
            code="material_part_family_model_required",
        )

    source_extension, source_filename = _validate_upload(
        source_file,
        allowed_extensions={"pdf"} if normalized_kind == "drawing" else SOURCE_EXTENSIONS,
    )
    preview_spec = None
    if preview_pdf is not None:
        preview_extension, preview_filename = _validate_upload(
            preview_pdf,
            allowed_extensions={"pdf"},
        )
        preview_spec = (preview_extension, preview_filename)

    # Validate both files before making the first external write. A database
    # failure can still leave an unreferenced object, but malformed previews do
    # not create avoidable source-file orphans.
    uploaded_assets: list[dict[str, Any]] = []
    try:
        source = _upload_field_document(
            source_file,
            kind=normalized_kind,
            extension=source_extension,
            filename=source_filename,
        )
        uploaded_assets.append(source)
        preview = source if source_extension == "pdf" else None
        if preview_spec is not None:
            preview_extension, preview_filename = preview_spec
            preview = _upload_field_document(
                preview_pdf,
                kind=f"{normalized_kind}-preview",
                extension=preview_extension,
                filename=preview_filename,
            )
            uploaded_assets.append(preview)
    except Exception:
        _cleanup_uploaded_documents(uploaded_assets)
        raise

    uploaded_at = timezone.now().astimezone(SHANGHAI_TZ).isoformat()
    username = str(getattr(user, "username", "") or getattr(user, "pk", "") or "unknown")
    document = {
        "id": uuid.uuid4().hex,
        "kind": normalized_kind,
        "part_no": normalized_part,
        "model_name": normalized_model,
        "revision": str(revision or "").strip()[:80],
        "match_rule": normalized_match_rule,
        "source": source,
        "preview": preview,
        "active": True,
        "uploaded_at": uploaded_at,
        "uploaded_by": username,
    }

    try:
        with transaction.atomic():
            snapshot, created = MouldDataSnapshot.objects.get_or_create(
                snapshot_key=FIELD_MATERIALS_SNAPSHOT_KEY,
                defaults={
                    "kind": MouldDataSnapshot.KIND_BOARD,
                    "instance_id": "field-materials",
                    "payload": _material_manifest_payload(),
                },
            )
            if not created:
                snapshot = MouldDataSnapshot.objects.select_for_update().get(pk=snapshot.pk)
            payload = _validate_material_manifest(snapshot.payload)
            documents = [row for row in payload["documents"] if isinstance(row, dict)]
            for previous in documents:
                previous_match_rule = _material_match_rule(previous.get("match_rule"))
                if normalized_match_rule == MATERIAL_MATCH_PART_FAMILY_LAST_TWO:
                    same_scope = (
                        previous_match_rule == MATERIAL_MATCH_PART_FAMILY_LAST_TWO
                        and material_parts_share_family(previous.get("part_no"), normalized_part)
                        and normalize_model_name(previous.get("model_name"))
                        == normalize_model_name(normalized_model)
                    )
                else:
                    same_scope = (
                        previous_match_rule == MATERIAL_MATCH_EXACT
                        and normalize_part_no(previous.get("part_no")) == normalized_part
                        and normalize_model_name(previous.get("model_name"))
                        == normalize_model_name(normalized_model)
                    )
                if (
                    previous.get("active", True)
                    and previous.get("kind") == normalized_kind
                    and same_scope
                ):
                    previous["active"] = False
            documents.append(document)
            snapshot.kind = MouldDataSnapshot.KIND_BOARD
            snapshot.instance_id = "field-materials"
            snapshot.payload = {
                "schema_version": FIELD_MATERIALS_SCHEMA,
                "documents": documents,
            }
            snapshot.source_latest_at = timezone.now()
            snapshot.last_error = ""
            snapshot.save()
    except Exception:
        _cleanup_uploaded_documents(uploaded_assets)
        raise
    return serialize_document(document) or {}


def build_field_material_readiness(
    target_date: date,
    *,
    include_status: bool = False,
) -> dict[str, Any]:
    documents = load_material_documents()
    production_summary = _production_summary_payload(target_date) if include_status else {}
    plans = list(
        ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type="injection",
            planned_quantity__gt=0,
        ).order_by("machine_name", "sequence", "id")
    )
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for plan in plans:
        part_no = normalize_part_no(plan.part_no)
        model_name = str(plan.model_name or plan.part_spec or "").strip()
        key = (part_no, normalize_model_name(model_name))
        row = grouped.setdefault(
            key,
            {
                "part_no": part_no,
                "model_name": model_name,
                "machine_numbers": [],
                "planned_quantity": 0,
                "sequence": _safe_int(plan.sequence, 999),
            },
        )
        machine_number = parse_machine_number(plan.machine_name)
        if machine_number and machine_number not in row["machine_numbers"]:
            row["machine_numbers"].append(machine_number)
        row["planned_quantity"] += _safe_int(plan.planned_quantity)
        row["sequence"] = min(row["sequence"], _safe_int(plan.sequence, 999))

    resolution_cache: dict[tuple[str, str], tuple[dict[str, Any], dict[str, bool]]] = {}

    def resolved_with_readiness(part_no: Any, model_name: Any) -> tuple[dict[str, Any], dict[str, bool]]:
        key = (normalize_part_no(part_no), normalize_model_name(model_name))
        cached = resolution_cache.get(key)
        if cached is not None:
            return cached
        resolved = resolve_material_documents(
            part_no,
            model_name,
            documents=documents,
        )
        instruction_ready = bool(resolved["work_instruction"] and resolved["work_instruction"].get("ready"))
        drawing_ready = bool(resolved["drawing"] and resolved["drawing"].get("ready"))
        readiness = {
            "work_instruction": instruction_ready,
            "drawing": drawing_ready,
            "complete": instruction_ready and drawing_ready,
        }
        resolution_cache[key] = (resolved, readiness)
        return resolved, readiness

    rows = []
    for row in grouped.values():
        resolved, readiness = resolved_with_readiness(row["part_no"], row["model_name"])
        rows.append({
            **row,
            "machine_numbers": sorted(row["machine_numbers"]),
            "work_instruction": resolved["work_instruction"],
            "drawing": resolved["drawing"],
            "readiness": readiness,
        })
    rows.sort(key=lambda row: (
        row["machine_numbers"][0] if row["machine_numbers"] else 999,
        row["sequence"],
        row["part_no"],
    ))
    summary_by_plan_id = {
        _safe_int(part.get("plan_id"), -1): part
        for machine in production_summary.get("machine_rows", [])
        if isinstance(machine, dict)
        for part in machine.get("parts", [])
        if isinstance(part, dict) and _safe_int(part.get("plan_id"), -1) > 0
    }
    plans_by_machine: dict[int, list[ProductionPlan]] = defaultdict(list)
    unmapped_plans = []
    for plan in plans:
        machine_number = parse_machine_number(plan.machine_name)
        if machine_number is None:
            unmapped_plans.append({
                "plan_id": plan.id,
                "machine_name": plan.machine_name,
                "part_no": normalize_part_no(plan.part_no),
                "model_name": str(plan.model_name or plan.part_spec or "").strip(),
                "sequence": _safe_int(plan.sequence),
            })
            continue
        plans_by_machine[machine_number].append(plan)

    machine_schedules = []
    for machine_number, machine_plans in plans_by_machine.items():
        machine_plans.sort(key=lambda plan: (_safe_int(plan.sequence, 999), _safe_int(plan.id, 999999)))
        schedule_plans = []
        for index, plan in enumerate(machine_plans):
            estimated = summary_by_plan_id.get(_safe_int(plan.id, -1), {})
            model_name = str(plan.model_name or plan.part_spec or "").strip()
            resolved, readiness = resolved_with_readiness(
                plan.part_no,
                model_name,
            )
            mes_estimated_status = str(estimated.get("status") or "") or None
            schedule_plans.append({
                "plan_id": plan.id,
                "sequence": _safe_int(plan.sequence),
                "source_sequence": _safe_int(plan.sequence),
                "display_order": index + 1,
                "lot_no": str(plan.lot_no or "").strip(),
                "part_no": normalize_part_no(plan.part_no),
                "model_name": model_name,
                "planned_quantity": _safe_int(plan.planned_quantity),
                "actual_quantity": _safe_int(estimated.get("estimated_qty")),
                "progress": float(estimated.get("progress_rate") or 0),
                "mes_estimated_status": mes_estimated_status,
                "status": mes_estimated_status or "planned",
                "is_current": False,
                "is_completed": mes_estimated_status == "completed",
                "work_instruction": resolved["work_instruction"],
                "drawing": resolved["drawing"],
                "readiness": readiness,
            })
        if include_status:
            active_index, active_plan = _select_active_plan(schedule_plans)
            if active_index is not None and active_plan and not active_plan["is_completed"]:
                schedule_plans[active_index]["is_current"] = True
        machine_schedules.append({
            "machine_number": machine_number,
            "machine_label": machine_label(machine_number),
            "machine_name": str(machine_plans[0].machine_name or "") if machine_plans else "",
            "plans": schedule_plans,
        })
    machine_schedules.sort(key=lambda item: item["machine_number"] or 999)

    return {
        "schema_version": FIELD_MATERIALS_SCHEMA,
        "business_date": target_date.isoformat(),
        "models": rows,
        "machine_schedules": machine_schedules,
        "status_meta": {
            "source": "mes_shot_allocation" if include_status else "not_requested",
            "latest_mes_time": _iso(production_summary.get("latest_mes_time")),
            "reference_time": _iso(production_summary.get("reference_time")),
            "generated_at": timezone.now().astimezone(SHANGHAI_TZ).isoformat(),
        },
        "warnings": (["unmapped_machine_plans"] if unmapped_plans else []),
        "unmapped_plans": unmapped_plans,
        "summary": {
            "total": len(rows),
            "complete": sum(1 for row in rows if row["readiness"]["complete"]),
            "missing_work_instruction": sum(1 for row in rows if not row["readiness"]["work_instruction"]),
            "missing_drawing": sum(1 for row in rows if not row["readiness"]["drawing"]),
            "scheduled_plans": sum(len(item["plans"]) for item in machine_schedules),
            "current_plans": sum(
                1 for item in machine_schedules for plan in item["plans"] if plan["is_current"]
            ),
            "missing_plans": sum(
                1 for item in machine_schedules for plan in item["plans"] if not plan["readiness"]["complete"]
            ),
        },
    }


def _quality_source_payload(target_date: date) -> dict[str, Any]:
    cache_key = f"field-kanban:quality:v1:{target_date.isoformat()}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return cached
    payload = build_daily_quality_attention(target_date, include_images=True)
    cache.set(cache_key, payload, timeout=5 * 60)
    return payload


def _production_summary_payload(target_date: date) -> dict[str, Any]:
    """Share the expensive 17-machine allocation across field terminals."""
    cache_key = f"field-kanban:production:v2:{target_date.isoformat()}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return cached
    payload = get_injection_summary(target_date)
    cache.set(cache_key, payload, timeout=30)
    return payload


def _machine_shot_payload(target_date: date, machine_number: int) -> dict[str, Any]:
    cache_key = f"field-kanban:shots:v1:{target_date.isoformat()}:{machine_number}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return cached
    payload = get_injection_machine_shot_context(target_date, [machine_number])
    cache.set(cache_key, payload, timeout=15)
    return payload


def _quality_summary(
    target_date: date,
    machine_number: int,
    part_no: Any,
    *,
    include_quality: bool,
) -> dict[str, Any]:
    empty = {
        "matching_report_count": 0,
        "issues": [],
        "disclaimer": QUALITY_DISCLAIMER,
    }
    if not include_quality:
        return {**empty, "unavailable_reason": "quality_permission_required"}
    part_prefix = normalize_part_no(part_no)[:9]
    if not part_prefix:
        return empty
    try:
        payload = _quality_source_payload(target_date)
    except Exception:
        return {**empty, "unavailable_reason": "quality_data_unavailable"}
    item = next(
        (
            row for row in payload.get("items", [])
            if _safe_int(row.get("machine_number"), -1) == machine_number
            and normalize_part_no(row.get("part_prefix")) == part_prefix
        ),
        None,
    )
    if not isinstance(item, dict):
        return empty

    issues: dict[str, dict[str, Any]] = {}
    for report in item.get("reports", []):
        if not isinstance(report, dict):
            continue
        report_dt = str(report.get("report_dt") or "")
        report_keys: set[str] = set()
        for problem in report.get("problem_types", []):
            if not isinstance(problem, dict):
                continue
            key = str(problem.get("key") or "").strip()
            label = problem.get("label") if isinstance(problem.get("label"), dict) else {}
            if not key or key in report_keys:
                continue
            report_keys.add(key)
            issue = issues.setdefault(
                key,
                {
                    "key": key,
                    "label": {
                        "zh": str(label.get("zh") or key),
                        "ko": str(label.get("ko") or key),
                    },
                    "evidence_count": 0,
                    "latest_report_dt": None,
                    "section": None,
                    "image_url": None,
                    "action_result": None,
                    "disposition": None,
                },
            )
            issue["evidence_count"] += 1
            if report_dt >= str(issue.get("latest_report_dt") or ""):
                images = report.get("images") if isinstance(report.get("images"), list) else []
                issue.update({
                    "latest_report_dt": report.get("report_dt"),
                    "section": report.get("section"),
                    "image_url": images[0] if images else None,
                    "action_result": report.get("action_result") or None,
                    "disposition": report.get("disposition") or None,
                })

    ordered = sorted(
        issues.values(),
        key=lambda issue: (-_safe_int(issue.get("evidence_count")), str(issue.get("key"))),
    )[:6]
    return {
        "matching_report_count": _safe_int(item.get("matching_report_count")),
        "issues": ordered,
        "disclaimer": QUALITY_DISCLAIMER,
        "match_basis": "machine_and_part_prefix_9",
        "part_prefix": part_prefix,
    }


def _plan_payload(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "plan_id": row.get("plan_id"),
        "sequence": _safe_int(row.get("sequence")),
        "part_no": row.get("part_no") or "",
        "model_name": row.get("model_name") or "",
        "lot_no": row.get("lot_no") or "",
        "planned_piece_qty": _safe_int(row.get("planned_qty")),
        "actual_piece_qty": _safe_int(row.get("estimated_qty")),
        "allocated_shots": _safe_int(row.get("allocated_shots")),
        "cavity": max(1, _safe_int(row.get("cavity"), 1)),
        "progress_rate": float(row.get("progress_rate") or 0),
        "status": row.get("status") or "pending",
        "production_group_id": row.get("production_group_id"),
        "production_group_complete": bool(row.get("production_group_complete", True)),
    }


def _select_active_plan(parts: list[dict[str, Any]]) -> tuple[int | None, dict[str, Any] | None]:
    for index, row in enumerate(parts):
        if row.get("status") == "in_progress":
            return index, row
    for index, row in enumerate(parts):
        if row.get("status") == "pending":
            return index, row
    if parts:
        return len(parts) - 1, parts[-1]
    return None, None


def _defect_snapshot_key(target_date: date, machine_number: int) -> str:
    return f"field-defects-v1-{target_date.strftime('%Y%m%d')}-{machine_number:02d}"


def _defect_document_payload(target_date: date, machine_number: int) -> dict[str, Any]:
    return {
        "schema_version": FIELD_DEFECTS_SCHEMA,
        "business_date": target_date.isoformat(),
        "machine_number": machine_number,
        "checkpoints": [],
    }


def _validate_defect_document(payload: Any, target_date: date, machine_number: int) -> dict[str, Any]:
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != FIELD_DEFECTS_SCHEMA
        or payload.get("business_date") != target_date.isoformat()
        or _safe_int(payload.get("machine_number"), -1) != machine_number
        or not isinstance(payload.get("checkpoints"), list)
    ):
        raise FieldKanbanError(
            "Stored defect checkpoint document is invalid.",
            code="invalid_defect_document",
            status_code=409,
        )
    return payload


def load_defect_checkpoints(target_date: date, machine_number: int) -> list[dict[str, Any]]:
    snapshot = MouldDataSnapshot.objects.filter(
        snapshot_key=_defect_snapshot_key(target_date, machine_number),
    ).first()
    if snapshot is None:
        return []
    payload = _validate_defect_document(snapshot.payload, target_date, machine_number)
    return [row for row in payload["checkpoints"] if isinstance(row, dict)]


def _pending_shift_prompt(
    target_date: date,
    machine_number: int,
    active_plan: dict[str, Any] | None,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    local_now = (now or timezone.now()).astimezone(SHANGHAI_TZ)
    current_business_date = current_shanghai_business_date(local_now)
    if target_date != current_business_date:
        return None
    if not active_plan:
        return None

    def completed_keys(business_date: date) -> set[str]:
        return {
            str(row.get("event_key"))
            for row in load_defect_checkpoints(business_date, machine_number)
        }

    def prompt_payload(
        business_date: date,
        plan: dict[str, Any] | None,
        *,
        event_key: str,
        trigger: str,
        due_at: datetime,
        cutoff_at: datetime,
    ) -> dict[str, Any]:
        return {
            "business_date": business_date.isoformat(),
            "event_key": event_key,
            "trigger": trigger,
            "due_at": due_at.isoformat(),
            "cutoff_at": cutoff_at.isoformat(),
            "is_overdue": local_now >= cutoff_at,
            "plan_id": plan.get("plan_id") if plan else None,
            "sequence": plan.get("sequence") if plan else None,
            "part_no": plan.get("part_no") if plan else "",
            "model_name": plan.get("model_name") if plan else "",
        }

    completed = completed_keys(target_date)
    candidates = [
        {
            "event_key": f"defect:shift:{target_date.isoformat()}:{machine_number}:2000",
            "trigger": "shift_2000",
            "due_at": SHANGHAI_TZ.localize(datetime.combine(target_date, time(19, 30))),
            "cutoff_at": SHANGHAI_TZ.localize(datetime.combine(target_date, time(20, 0))),
        },
        {
            "event_key": f"defect:shift:{target_date.isoformat()}:{machine_number}:0800",
            "trigger": "shift_0800",
            "due_at": SHANGHAI_TZ.localize(datetime.combine(target_date + timedelta(days=1), time(7, 30))),
            "cutoff_at": SHANGHAI_TZ.localize(datetime.combine(target_date + timedelta(days=1), time(8, 0))),
        },
    ]
    for candidate in sorted(candidates, key=lambda row: row["due_at"], reverse=True):
        if (
            local_now < candidate["due_at"]
            or candidate["event_key"] in completed
        ):
            continue
        return prompt_payload(
            target_date,
            active_plan,
            event_key=candidate["event_key"],
            trigger=candidate["trigger"],
            due_at=candidate["due_at"],
            cutoff_at=candidate["cutoff_at"],
        )
    return None


def _defect_checkpoint_context(target_date: date, machine_number: int) -> dict[str, Any]:
    """Build only the plan and reset-safe counter data needed by a defect write."""
    summary = get_injection_summary(
        target_date,
        machine_numbers=[machine_number],
    )
    summary_row = next(
        (
            row for row in summary.get("machine_rows", [])
            if _safe_int(row.get("machine_number"), -1) == machine_number
        ),
        None,
    )
    parts = list(summary_row.get("parts", [])) if isinstance(summary_row, dict) else []
    _active_index, active_source = _select_active_plan(parts)
    queue = [payload for payload in (_plan_payload(row) for row in parts) if payload]
    return {
        "active_plan": _plan_payload(active_source),
        "queue": queue,
        "counters": {
            "business_day_shots": _safe_int((summary_row or {}).get("shot_count")),
        },
    }


def _validate_checkpoint_event(
    *,
    target_date: date,
    machine_number: int,
    event_key: str,
    trigger: str,
    now: datetime,
) -> None:
    if trigger == "part_change":
        match = re.fullmatch(
            r"defect:part-change:(\d{4}-\d{2}-\d{2}):(\d+):(\d+):gap",
            event_key,
        )
        if (
            match is None
            or match.group(1) != target_date.isoformat()
            or int(match.group(2)) != machine_number
        ):
            raise FieldKanbanError(
                "The part-change event key does not match its date and machine.",
                code="invalid_part_change_event_key",
            )
        return
    if trigger == "manual":
        match = re.fullmatch(
            r"manual:(\d{4}-\d{2}-\d{2}):(\d+):(\d+)",
            event_key,
        )
        if (
            match is None
            or match.group(1) != target_date.isoformat()
            or int(match.group(2)) != machine_number
        ):
            raise FieldKanbanError(
                "The manual event key does not match its date and machine.",
                code="invalid_manual_event_key",
            )
        return
    if trigger not in {"shift_0800", "shift_2000"}:
        return
    suffix = "0800" if trigger == "shift_0800" else "2000"
    expected_event_key = (
        f"defect:shift:{target_date.isoformat()}:{machine_number}:{suffix}"
    )
    if event_key != expected_event_key:
        raise FieldKanbanError(
            "The shift event key does not match its date, machine, and trigger.",
            code="invalid_shift_event_key",
        )
    due_at = SHANGHAI_TZ.localize(datetime.combine(
        target_date + (timedelta(days=1) if trigger == "shift_0800" else timedelta()),
        time(7, 30) if trigger == "shift_0800" else time(19, 30),
    ))
    if now < due_at:
        raise FieldKanbanError(
            "The shift defect checkpoint is not due yet.",
            code="shift_checkpoint_not_due",
            status_code=409,
        )


def _latest_confirmation(target_date: date, machine_number: int) -> dict[str, Any] | None:
    confirmation = (
        InjectionDowntimeConfirmation.objects.filter(
            business_date=target_date,
            machine_key__in=[str(machine_number), f"{machine_number}호기", machine_label(machine_number)],
        )
        .order_by("-confirmed_at", "-id")
        .first()
    )
    if not confirmation:
        return None
    return {
        "event_key": confirmation.event_key,
        "detected_type": confirmation.detected_type,
        "resolution": confirmation.resolution,
        "reason_code": confirmation.reason_code,
        "evidence": confirmation.evidence,
        "confirmed_at": _iso(confirmation.confirmed_at),
        "confirmed_by": getattr(confirmation.confirmed_by, "username", None),
    }


def build_field_kanban_snapshot(
    target_date: date,
    machine_number: int,
    *,
    include_quality: bool = True,
    now: datetime | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    if not 1 <= int(machine_number) <= 17:
        raise FieldKanbanError("machine_number must be between 1 and 17.", code="invalid_machine_number")
    machine_number = int(machine_number)
    local_now = (now or timezone.now()).astimezone(SHANGHAI_TZ)

    summary = _production_summary_payload(target_date) if use_cache else get_injection_summary(target_date)
    summary_row = next(
        (row for row in summary.get("machine_rows", []) if _safe_int(row.get("machine_number")) == machine_number),
        None,
    )
    shot_context = (
        _machine_shot_payload(target_date, machine_number)
        if use_cache else get_injection_machine_shot_context(target_date, [machine_number])
    )
    shot_row = (shot_context.get("rows") or [{}])[0]
    parts = list(summary_row.get("parts", [])) if isinstance(summary_row, dict) else []
    active_index, active_source = _select_active_plan(parts)
    queue = [_plan_payload(row) for row in parts]
    queue = [row for row in queue if row is not None]
    active_plan = _plan_payload(active_source)
    next_plan = queue[active_index + 1] if active_index is not None and active_index + 1 < len(queue) else None
    shot_count = _safe_int(shot_row.get("shot_count"), _safe_int((summary_row or {}).get("shot_count")))
    recent_shots = _safe_int(shot_row.get("recent_60m_shots"), _safe_int((summary_row or {}).get("recent_60m_shots")))

    documents = resolve_material_documents(
        active_plan.get("part_no") if active_plan else "",
        active_plan.get("model_name") if active_plan else "",
    )
    quality = _quality_summary(
        target_date,
        machine_number,
        active_plan.get("part_no") if active_plan else "",
        include_quality=include_quality,
    )

    theoretical_piece_qty = (
        active_plan["allocated_shots"] * active_plan["cavity"]
        if active_plan else 0
    )
    estimated_change_at = None
    if active_plan and recent_shots > 0 and active_plan["status"] != "completed":
        remaining_piece_qty = max(0, active_plan["planned_piece_qty"] - active_plan["actual_piece_qty"])
        remaining_shots = math.ceil(remaining_piece_qty / max(1, active_plan["cavity"]))
        seconds_per_shot = 3600 / recent_shots
        estimated_change_at = (local_now + timedelta(seconds=remaining_shots * seconds_per_shot)).isoformat()

    warnings: list[str] = []
    if not parts:
        warnings.append("production_plan_missing")
    if shot_row.get("warning"):
        warnings.append(str(shot_row["warning"]))
    if active_plan and not documents["work_instruction"]:
        warnings.append("work_instruction_missing")
    if active_plan and not documents["drawing"]:
        warnings.append("drawing_missing")

    return {
        "schema_version": FIELD_KANBAN_SCHEMA,
        "business_date": target_date.isoformat(),
        "server_time": local_now.isoformat(),
        "machine": {
            "number": machine_number,
            "key": str(machine_number),
            "label": machine_label(machine_number),
            "monitoring_name": machine_monitoring_name(machine_number),
            "device_counter": (
                _safe_int(shot_row.get("latest_capacity"))
                if shot_row.get("latest_capacity") is not None else None
            ),
            "shot_count": shot_count,
            "recent_60m_shots": recent_shots,
            "latest_mes_time": _iso(shot_row.get("latest_mes_time")),
            "is_stale": bool(shot_row.get("is_stale", True)),
            "is_running": recent_shots > 0 and not bool(shot_row.get("is_stale", True)),
            "estimated_change_at": estimated_change_at,
        },
        "active_plan": active_plan,
        "next_plan": next_plan,
        "queue": queue,
        "counters": {
            "business_day_shots": shot_count,
            "current_plan_shots": active_plan["allocated_shots"] if active_plan else 0,
            "theoretical_piece_qty": theoretical_piece_qty,
        },
        "documents": documents,
        "quality": quality,
        "pending_prompt": _pending_shift_prompt(
            target_date,
            machine_number,
            active_plan,
            now=local_now,
        ),
        "latest_confirmation": _latest_confirmation(target_date, machine_number),
        "defect_types": DEFECT_TYPES,
        "data_freshness": {
            "latest_mes_time": _iso(shot_row.get("latest_mes_time")),
            "quality_cache_seconds": 300,
        },
        "warnings": warnings,
    }


def _normalize_defect_items(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise FieldKanbanError("items must be a list.", code="invalid_defect_items")
    quantities: defaultdict[str, int] = defaultdict(int)
    for raw in items:
        if not isinstance(raw, dict):
            raise FieldKanbanError("Each defect item must be an object.", code="invalid_defect_item")
        code = str(raw.get("code") or "").strip()
        if code not in DEFECT_CODES:
            raise FieldKanbanError(f"Unknown defect type: {code}.", code="invalid_defect_code")
        try:
            quantity = int(raw.get("quantity", 0))
        except (TypeError, ValueError) as exc:
            raise FieldKanbanError("Defect quantity must be an integer.", code="invalid_defect_quantity") from exc
        if quantity < 0:
            raise FieldKanbanError("Defect quantity cannot be negative.", code="invalid_defect_quantity")
        quantities[code] += quantity
    return [
        {"code": code, "quantity": quantity}
        for code, quantity in quantities.items()
        if quantity > 0
    ]


def save_defect_checkpoint(
    *,
    target_date: date,
    machine_number: int,
    event_key: Any,
    trigger: Any,
    items: Any,
    user: Any,
    plan_id: Any = None,
    part_no: Any = "",
    sequence: Any = None,
    now: datetime | None = None,
) -> tuple[dict[str, Any], bool]:
    machine_number = int(machine_number)
    if not 1 <= machine_number <= 17:
        raise FieldKanbanError("machine_number must be between 1 and 17.", code="invalid_machine_number")
    normalized_event_key = str(event_key or "").strip()
    if not normalized_event_key or len(normalized_event_key) > 200:
        raise FieldKanbanError("A valid event_key is required.", code="invalid_event_key")
    normalized_trigger = str(trigger or "").strip()
    if normalized_trigger not in {"part_change", "shift_0800", "shift_2000", "manual"}:
        raise FieldKanbanError("Unknown defect checkpoint trigger.", code="invalid_trigger")
    normalized_items = _normalize_defect_items(items)
    local_now = (now or timezone.now()).astimezone(SHANGHAI_TZ)
    _validate_checkpoint_event(
        target_date=target_date,
        machine_number=machine_number,
        event_key=normalized_event_key,
        trigger=normalized_trigger,
        now=local_now,
    )

    existing = next(
        (
            row for row in load_defect_checkpoints(target_date, machine_number)
            if row.get("event_key") == normalized_event_key
        ),
        None,
    )
    if existing:
        return existing, False

    context = _defect_checkpoint_context(target_date, machine_number)
    queue = context.get("queue") or []
    requested_plan_id = None
    if plan_id not in (None, ""):
        try:
            requested_plan_id = int(plan_id)
        except (TypeError, ValueError) as exc:
            raise FieldKanbanError("plan_id must be an integer.", code="invalid_plan_id") from exc
        if requested_plan_id <= 0:
            raise FieldKanbanError("plan_id must be a positive integer.", code="invalid_plan_id")
    requested_part = normalize_part_no(part_no)
    requested_sequence = None
    if sequence not in (None, ""):
        try:
            requested_sequence = int(sequence)
        except (TypeError, ValueError) as exc:
            raise FieldKanbanError("sequence must be an integer.", code="invalid_sequence") from exc
    plan = None
    if requested_plan_id is not None:
        plan = next(
            (row for row in queue if _safe_int(row.get("plan_id"), -1) == requested_plan_id),
            None,
        )
        if plan is not None and requested_part and normalize_part_no(plan.get("part_no")) != requested_part:
            plan = None
        if plan is None:
            raise FieldKanbanError(
                "The requested production-plan row was not found.",
                code="production_plan_identity_mismatch",
                status_code=409,
            )
    elif requested_part:
        part_candidates = [
            row for row in queue
            if normalize_part_no(row.get("part_no")) == requested_part
        ]
        if requested_sequence is not None:
            plan = next(
                (
                    row for row in part_candidates
                    if _safe_int(row.get("sequence"), -1) == requested_sequence
                ),
                None,
            )
        # The field queue historically exposed a synthesized 1-based sequence,
        # while transition analysis used the uploaded Excel row sequence. A
        # unique part remains unambiguous even when those legacy values differ.
        if plan is None and len(part_candidates) == 1:
            plan = part_candidates[0]
        if plan is None:
            raise FieldKanbanError(
                "The requested production-plan row was not found.",
                code="production_plan_identity_mismatch",
                status_code=409,
            )
    else:
        plan = context.get("active_plan")
    if not plan:
        raise FieldKanbanError(
            "No injection production plan is available for this checkpoint.",
            code="production_plan_missing",
            status_code=409,
        )

    current_plan_shots = _safe_int(plan.get("allocated_shots"))
    observed_business_day_shots = _safe_int(
        context.get("counters", {}).get("business_day_shots")
    )
    cavity = max(1, _safe_int(plan.get("cavity"), 1))
    username = str(getattr(user, "username", "") or getattr(user, "pk", "") or "unknown")

    snapshot_key = _defect_snapshot_key(target_date, machine_number)
    with transaction.atomic():
        document, created = MouldDataSnapshot.objects.get_or_create(
            snapshot_key=snapshot_key,
            defaults={
                "kind": MouldDataSnapshot.KIND_BOARD,
                "instance_id": f"field-defects-{machine_number:02d}",
                "payload": _defect_document_payload(target_date, machine_number),
            },
        )
        if not created:
            document = MouldDataSnapshot.objects.select_for_update().get(pk=document.pk)
        payload = _validate_defect_document(document.payload, target_date, machine_number)
        checkpoints = [row for row in payload["checkpoints"] if isinstance(row, dict)]
        for checkpoint in checkpoints:
            if checkpoint.get("event_key") == normalized_event_key:
                return checkpoint, False

        previous_business_day_shots = max(
            (_safe_int(row.get("ending_business_day_shots")) for row in checkpoints),
            default=0,
        )
        # The business-day counter is reset-safe and monotonic across plan
        # completion/overrun. Using the maximum persisted ending counter also
        # prevents a stale concurrent request from regressing the next baseline.
        ending_business_day_shots = max(
            observed_business_day_shots,
            previous_business_day_shots,
        )
        segment_shots = ending_business_day_shots - previous_business_day_shots
        gross_piece_qty = segment_shots * cavity
        defect_piece_qty = sum(_safe_int(row.get("quantity")) for row in normalized_items)
        if defect_piece_qty > gross_piece_qty:
            raise FieldKanbanError(
                "Defect quantity cannot exceed the server-calculated gross piece quantity.",
                code="defect_exceeds_gross_quantity",
                status_code=409,
            )

        checkpoint = {
            "id": hashlib.sha256(
                f"{target_date}:{machine_number}:{normalized_event_key}".encode("utf-8")
            ).hexdigest()[:24],
            "event_key": normalized_event_key,
            "trigger": normalized_trigger,
            "business_date": target_date.isoformat(),
            "machine_number": machine_number,
            "plan_id": plan.get("plan_id"),
            "sequence": _safe_int(plan.get("sequence")),
            "part_no": plan.get("part_no") or "",
            "model_name": plan.get("model_name") or "",
            "ending_business_day_shots": ending_business_day_shots,
            "ending_plan_shots": current_plan_shots,
            "segment_shots": segment_shots,
            "cavity": cavity,
            "gross_piece_qty": gross_piece_qty,
            "items": normalized_items,
            "defect_piece_qty": defect_piece_qty,
            "good_piece_qty": gross_piece_qty - defect_piece_qty,
            "completed_at": local_now.isoformat(),
            "completed_by": username,
        }
        checkpoints.append(checkpoint)
        document.kind = MouldDataSnapshot.KIND_BOARD
        document.instance_id = f"field-defects-{machine_number:02d}"
        document.payload = {
            "schema_version": FIELD_DEFECTS_SCHEMA,
            "business_date": target_date.isoformat(),
            "machine_number": machine_number,
            "checkpoints": checkpoints,
        }
        document.source_latest_at = timezone.now()
        document.last_error = ""
        document.save()
    return checkpoint, True
