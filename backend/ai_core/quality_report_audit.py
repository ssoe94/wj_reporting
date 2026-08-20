"""Authoritative contract for per-report Qwen quality/photo audits.

The local worker is allowed to return candidate indices and bounded visual
observations only.  Report identity, exact Part No., taxonomy labels and
master-colour context are always restored from the server-owned job input.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any


QUALITY_REPORT_AUDIT_MODE = "report_taxonomy_audit"
QUALITY_REPORT_AUDIT_TRIGGER = "quality_report_scan"
QUALITY_REPORT_AUDIT_SOURCE = "quality_report_taxonomy_audit"
QUALITY_REPORT_AUDIT_RESULT_SCHEMA_VERSION = "quality-report-taxonomy-audit.v1"
QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION = (
    "quality-report-taxonomy-audit-worker.v1"
)
QUALITY_REPORT_AUDIT_PROMPT_VERSION = (
    "quality-report-taxonomy-audit-qwen38-v1"
)

QUALITY_BODY_COLOR_LABELS: dict[str, dict[str, str]] = {
    "white": {"ko": "백색", "zh": "白色"},
    "black": {"ko": "검정", "zh": "黑色"},
    "gray": {"ko": "회색", "zh": "灰色"},
    "silver": {"ko": "은색", "zh": "银色"},
    "beige": {"ko": "베이지", "zh": "米色"},
    "transparent": {"ko": "투명", "zh": "透明"},
    "blue": {"ko": "파랑", "zh": "蓝色"},
    "red": {"ko": "빨강", "zh": "红色"},
    "other": {"ko": "기타 색상", "zh": "其他颜色"},
    "undetermined": {"ko": "판정 불가", "zh": "无法判断"},
}
QUALITY_BODY_COLOR_KEYS = frozenset(QUALITY_BODY_COLOR_LABELS)
QUALITY_AUDIT_CONFIDENCE_KEYS = frozenset({"low", "medium", "high"})
QUALITY_AUDIT_UNCERTAINTY_CODES = frozenset({
    "lighting",
    "glare",
    "partial_product",
    "background_dominant",
    "defect_mark_only",
    "multiple_products",
    "conflicting_images",
})
QUALITY_AUDIT_EVIDENCE_BASIS = frozenset({"report_text", "image"})
QUALITY_AUDIT_REVIEW_REASON_CODES = frozenset({
    "dictionary_unclassified",
    "classification_disagreement",
    "low_confidence",
    "needs_new_category",
    "master_color_missing",
    "master_color_mismatch",
    "visual_color_uncertain",
    "no_usable_image",
    "partial_image_processing",
    "unversioned_image_reference",
})


def is_quality_report_audit_job(job: Any) -> bool:
    scope = getattr(job, "scope", None)
    job_type = getattr(job, "job_type", None)
    if isinstance(job, dict):
        scope = job.get("scope")
        job_type = job.get("job_type")
    return bool(
        job_type == "quality_image_analysis"
        and isinstance(scope, dict)
        and scope.get("mode") == QUALITY_REPORT_AUDIT_MODE
        and scope.get("trigger") == QUALITY_REPORT_AUDIT_TRIGGER
    )


def _int_index(value: Any, *, upper_bound: int) -> int | None:
    if type(value) is not int or value < 0 or value >= upper_bound:
        return None
    return value


def _confidence(value: Any) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if candidate in QUALITY_AUDIT_CONFIDENCE_KEYS else "low"


def _deterministic_leaf_keys(rows: Any) -> list[str]:
    keys: list[str] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        observed = row.get("observed_terms")
        observed_rows = observed if isinstance(observed, list) else []
        observed_keys = [
            str(item.get("key") or "")
            for item in observed_rows
            if isinstance(item, dict) and str(item.get("key") or "")
        ]
        values = observed_keys or [str(row.get("key") or "")]
        for key in values:
            if key and key not in keys:
                keys.append(key)
    return keys


def _validated_processed_images(
    worker_result: dict[str, Any],
    image_refs: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    allowed_refs = {
        str(item.get("slot") or ""): item
        for item in image_refs
        if isinstance(item, dict) and str(item.get("slot") or "")
    }
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    raw_rows = worker_result.get("processed_images")
    for row in raw_rows if isinstance(raw_rows, list) else []:
        if not isinstance(row, dict):
            continue
        slot = str(row.get("slot") or "")
        digest = str(row.get("sha256") or "").lower()
        if (
            slot not in allowed_refs
            or slot in seen
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            continue
        seen.add(slot)
        source_ref = allowed_refs[slot]
        result.append({
            "slot": slot,
            "sha256": digest,
            "reference_sha256": str(source_ref.get("reference_sha256") or ""),
            "immutable_reference": source_ref.get("immutable_reference") is True,
        })
    return result


def _validated_image_observations(
    worker_result: dict[str, Any],
    processed_images: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[int] = set()
    raw_rows = worker_result.get("image_observations")
    for row in raw_rows if isinstance(raw_rows, list) else []:
        if not isinstance(row, dict):
            continue
        image_index = _int_index(
            row.get("image_index"),
            upper_bound=len(processed_images),
        )
        if image_index is None or image_index in seen:
            continue
        seen.add(image_index)
        product_visible = row.get("product_visible") is True
        color_key = str(row.get("body_color_key") or "").strip().lower()
        if color_key not in QUALITY_BODY_COLOR_KEYS:
            color_key = "undetermined"
        if not product_visible:
            color_key = "undetermined"
        uncertainty_codes = [
            str(code)
            for code in row.get("uncertainty_codes") or []
            if str(code) in QUALITY_AUDIT_UNCERTAINTY_CODES
        ]
        uncertainty_codes = list(dict.fromkeys(uncertainty_codes))[:5]
        result.append({
            "image_index": image_index,
            "slot": processed_images[image_index]["slot"],
            "product_visible": product_visible,
            "body_color_key": color_key,
            "body_color_label": deepcopy(QUALITY_BODY_COLOR_LABELS[color_key]),
            "confidence": _confidence(row.get("confidence")),
            "uncertainty_codes": uncertainty_codes,
        })
    return result


def _strict_worker_result_is_valid(
    worker: dict[str, Any],
    *,
    candidates: list[dict[str, Any]],
    image_refs: list[dict[str, Any]],
    processed_images: list[dict[str, Any]],
    observations: list[dict[str, Any]],
) -> bool:
    """Independently enforce the bounded worker contract on the server.

    The local JSON-schema decoder is a convenience, not a trust boundary.  A
    compromised or obsolete worker must not be able to turn a malformed result
    into an available audit merely by copying the schema-version string.
    """

    indices = worker.get("defect_candidate_indices")
    evidence_basis = worker.get("evidence_basis")
    raw_processed = worker.get("processed_images")
    raw_observations = worker.get("image_observations")
    review_codes = worker.get("review_reason_codes")
    if (
        worker.get("schema_version")
        != QUALITY_REPORT_AUDIT_WORKER_SCHEMA_VERSION
        or worker.get("llm_fallback") is not False
        or worker.get("llm_attempted") is not True
        or worker.get("model_id") != "qwen38"
        or worker.get("source") != "local_qwen38_multimodal"
        or not isinstance(indices, list)
        or not isinstance(evidence_basis, list)
        or not isinstance(raw_processed, list)
        or not isinstance(raw_observations, list)
        or not isinstance(review_codes, list)
        or worker.get("defect_confidence") not in QUALITY_AUDIT_CONFIDENCE_KEYS
        or type(worker.get("needs_new_category")) is not bool
    ):
        return False
    if (
        len(indices) > 6
        or any(
            type(value) is not int or value < 0 or value >= len(candidates)
            for value in indices
        )
        or len(indices) != len(set(indices))
    ):
        return False
    if (
        not evidence_basis
        or len(evidence_basis) > 2
        or any(
            not isinstance(value, str)
            or value not in QUALITY_AUDIT_EVIDENCE_BASIS
            for value in evidence_basis
        )
        or len(evidence_basis) != len(set(evidence_basis))
    ):
        return False
    if not processed_images and "image" in evidence_basis:
        return False
    if (
        len(raw_processed) > min(5, len(image_refs))
        or len(raw_processed) != len(processed_images)
        or len(raw_observations) != len(observations)
        or len(raw_observations) != len(processed_images)
        or any(not isinstance(row, dict) for row in raw_observations)
    ):
        return False
    if {row.get("image_index") for row in raw_observations} != set(
        range(len(processed_images))
    ):
        return False
    for row in raw_observations:
        if (
            not isinstance(row, dict)
            or type(row.get("product_visible")) is not bool
            or not isinstance(row.get("body_color_key"), str)
            or row.get("body_color_key") not in QUALITY_BODY_COLOR_KEYS
            or not isinstance(row.get("confidence"), str)
            or row.get("confidence") not in QUALITY_AUDIT_CONFIDENCE_KEYS
        ):
            return False
        if (
            row.get("product_visible") is False
            and row.get("body_color_key") != "undetermined"
        ):
            return False
        uncertainty_codes = row.get("uncertainty_codes")
        if (
            not isinstance(uncertainty_codes, list)
            or len(uncertainty_codes) > 5
            or any(
                not isinstance(code, str)
                or code not in QUALITY_AUDIT_UNCERTAINTY_CODES
                for code in uncertainty_codes
            )
            or len(uncertainty_codes) != len(set(uncertainty_codes))
        ):
            return False
    if (
        len(review_codes) > 8
        or any(
            not isinstance(code, str)
            or code not in QUALITY_AUDIT_REVIEW_REASON_CODES
            for code in review_codes
        )
        or len(review_codes) != len(set(review_codes))
    ):
        return False
    return True


def _product_color_suggestion(
    observations: list[dict[str, Any]],
    *,
    exact_part_no: str,
    processed_images: list[dict[str, Any]],
    expected_image_count: int,
) -> dict[str, Any]:
    if len(processed_images) != expected_image_count:
        return {
            "exact_part_no": exact_part_no,
            "match_basis": "exact_quality_report_part_no",
            "suggested_color_key": "undetermined",
            "suggested_color_label": deepcopy(
                QUALITY_BODY_COLOR_LABELS["undetermined"]
            ),
            "confidence": "low",
            "evidence_image_slots": [],
            "status": "partial_image_processing",
            "master_write_allowed": False,
        }
    if any(row.get("immutable_reference") is not True for row in processed_images):
        return {
            "exact_part_no": exact_part_no,
            "match_basis": "exact_quality_report_part_no",
            "suggested_color_key": "undetermined",
            "suggested_color_label": deepcopy(
                QUALITY_BODY_COLOR_LABELS["undetermined"]
            ),
            "confidence": "low",
            "evidence_image_slots": [],
            "status": "unversioned_image_reference",
            "master_write_allowed": False,
        }
    assessable = [
        row for row in observations
        if row.get("product_visible") is True
        and row.get("body_color_key") not in {"", "undetermined"}
    ]
    colors = list(dict.fromkeys(str(row["body_color_key"]) for row in assessable))
    if not assessable:
        color_key = "undetermined"
        status = "no_assessable_image"
        evidence_slots: list[str] = []
        confidence = "low"
    elif len(colors) != 1:
        color_key = "undetermined"
        status = "conflicting_images"
        evidence_slots = [str(row["slot"]) for row in assessable]
        confidence = "low"
    else:
        color_key = colors[0]
        status = "review_required"
        matching = [row for row in assessable if row["body_color_key"] == color_key]
        evidence_slots = [str(row["slot"]) for row in matching]
        confidence_order = {"low": 0, "medium": 1, "high": 2}
        confidence = min(
            (str(row.get("confidence") or "low") for row in matching),
            key=lambda value: confidence_order.get(value, 0),
        )
    return {
        "exact_part_no": exact_part_no,
        "match_basis": "exact_quality_report_part_no",
        "suggested_color_key": color_key,
        "suggested_color_label": deepcopy(QUALITY_BODY_COLOR_LABELS[color_key]),
        "confidence": confidence,
        "evidence_image_slots": evidence_slots,
        "status": status,
        "master_write_allowed": False,
    }


def _master_color_comparison(
    suggestion: dict[str, Any],
    part_spec: dict[str, Any],
) -> dict[str, Any]:
    suggested = str(suggestion.get("suggested_color_key") or "undetermined")
    master = str(part_spec.get("color_key") or "").strip().lower() or None
    if suggested == "undetermined":
        status = "visual_color_uncertain"
    elif not master:
        status = "master_color_missing"
    elif master == suggested:
        status = "match"
    else:
        status = "mismatch"
    return {
        "status": status,
        "suggested_color_key": suggested,
        "master_color_key": master,
        "master_color_raw": str(part_spec.get("color_raw") or ""),
        "part_spec_id": part_spec.get("id"),
        "part_spec_valid_from": part_spec.get("valid_from"),
        "match_basis": part_spec.get("match_basis") or "no_exact_part_spec",
    }


def restore_authoritative_quality_report_audit_result(
    job: Any,
    worker_result: Any,
) -> dict[str, Any]:
    """Validate a worker result and reattach every authoritative identity."""

    input_payload = getattr(job, "input_payload", None)
    scope = getattr(job, "scope", None)
    if not isinstance(input_payload, dict) or not isinstance(scope, dict):
        return {
            "schema_version": QUALITY_REPORT_AUDIT_RESULT_SCHEMA_VERSION,
            "available": False,
            "reason": "invalid_server_job_contract",
        }
    report = input_payload.get("report")
    candidates = input_payload.get("taxonomy_candidates")
    image_refs = report.get("image_refs") if isinstance(report, dict) else None
    if (
        not isinstance(report, dict)
        or not isinstance(candidates, list)
        or not isinstance(image_refs, list)
    ):
        return {
            "schema_version": QUALITY_REPORT_AUDIT_RESULT_SCHEMA_VERSION,
            "available": False,
            "reason": "invalid_server_job_contract",
        }

    worker = worker_result if isinstance(worker_result, dict) else {}
    processed_images = _validated_processed_images(worker, image_refs)
    observations = _validated_image_observations(worker, processed_images)
    worker_schema_valid = _strict_worker_result_is_valid(
        worker,
        candidates=candidates,
        image_refs=image_refs,
        processed_images=processed_images,
        observations=observations,
    )

    selected: list[dict[str, Any]] = []
    seen_indices: set[int] = set()
    raw_indices = worker.get("defect_candidate_indices")
    for value in raw_indices if isinstance(raw_indices, list) else []:
        index = _int_index(value, upper_bound=len(candidates))
        if index is None or index in seen_indices:
            continue
        candidate = candidates[index]
        if not isinstance(candidate, dict) or not str(candidate.get("key") or ""):
            continue
        seen_indices.add(index)
        selected.append({
            "candidate_index": index,
            "key": str(candidate["key"]),
            "parent_key": str(candidate.get("parent_key") or "") or None,
            "label": deepcopy(candidate.get("label") or {}),
        })

    product_color = _product_color_suggestion(
        observations,
        exact_part_no=str(report.get("part_no") or ""),
        processed_images=processed_images,
        expected_image_count=len(image_refs),
    )
    part_spec = (
        input_payload.get("part_spec")
        if isinstance(input_payload.get("part_spec"), dict)
        else {}
    )
    color_comparison = _master_color_comparison(product_color, part_spec)
    deterministic = input_payload.get("deterministic_classification")
    deterministic_keys = _deterministic_leaf_keys(deterministic)
    selected_keys = [str(row["key"]) for row in selected]
    confidence = _confidence(worker.get("defect_confidence"))
    needs_new_category = worker.get("needs_new_category") is True

    reasons: list[str] = []
    if "unclassified" in deterministic_keys:
        reasons.append("dictionary_unclassified")
    if set(selected_keys) != set(deterministic_keys):
        reasons.append("classification_disagreement")
    if confidence == "low":
        reasons.append("low_confidence")
    if needs_new_category:
        reasons.append("needs_new_category")
    if color_comparison["status"] == "master_color_missing" and product_color["suggested_color_key"] != "undetermined":
        reasons.append("master_color_missing")
    elif color_comparison["status"] == "mismatch":
        reasons.append("master_color_mismatch")
    elif color_comparison["status"] == "visual_color_uncertain" and image_refs:
        reasons.append("visual_color_uncertain")
    if image_refs and not processed_images:
        reasons.append("no_usable_image")
    elif len(processed_images) != len(image_refs):
        reasons.append("partial_image_processing")
    if (
        product_color.get("status") == "review_required"
        and (
            product_color.get("confidence") != "high"
            or any(row.get("uncertainty_codes") for row in observations)
        )
    ):
        reasons.append("visual_color_uncertain")
    if product_color.get("status") == "unversioned_image_reference":
        reasons.append("unversioned_image_reference")
    raw_review_codes = worker.get("review_reason_codes")
    for code in raw_review_codes if isinstance(raw_review_codes, list) else []:
        code = str(code)
        if code in QUALITY_AUDIT_REVIEW_REASON_CODES:
            reasons.append(code)
    reasons = list(dict.fromkeys(reasons))

    available = worker_schema_valid
    return {
        "schema_version": QUALITY_REPORT_AUDIT_RESULT_SCHEMA_VERSION,
        "available": available,
        "source": "local_qwen38_multimodal" if available else "unavailable",
        "reason": None if available else str(
            worker.get("llm_fallback_code") or "invalid_worker_result"
        ),
        "report": {
            "id": report.get("id"),
            "source_revision": str(scope.get("source_revision") or ""),
            "report_source_revision": str(
                input_payload.get("report_source_revision") or ""
            ),
            "updated_at": report.get("updated_at"),
            "part_no": str(report.get("part_no") or ""),
            "model": str(report.get("model") or ""),
        },
        "taxonomy_version": str(scope.get("taxonomy_version") or ""),
        "raw_text_sha256": str(input_payload.get("raw_text_sha256") or ""),
        "deterministic_classification": deepcopy(
            deterministic if isinstance(deterministic, list) else []
        ),
        "qwen_classification": {
            "candidate_selections": selected,
            "confidence": confidence,
            "needs_new_category": needs_new_category,
            "evidence_basis": [
                str(value)
                for value in (
                    worker.get("evidence_basis")
                    if isinstance(worker.get("evidence_basis"), list)
                    else []
                )
                if str(value) in QUALITY_AUDIT_EVIDENCE_BASIS
            ],
        },
        "processed_images": processed_images,
        "image_observations": observations,
        "product_color_suggestion": product_color,
        "master_color_comparison": color_comparison,
        "review_required": bool(reasons),
        "review_reason_codes": reasons,
        "review": None,
        "review_history": [],
    }
