"""Bounded Qwen3.8 text/photo audit for one quality report."""

from __future__ import annotations

from io import BytesIO
import hashlib
from pathlib import Path
import tempfile
import time
from typing import Any
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps, UnidentifiedImageError


PROMPT_VERSION = "quality-report-taxonomy-audit-qwen38-v1"
WORKER_SCHEMA_VERSION = "quality-report-taxonomy-audit-worker.v1"
MODE = "report_taxonomy_audit"
TRIGGER = "quality_report_scan"
SOURCE = "quality_report_taxonomy_audit"
REQUIRE_LLM_FOR_READY_RESULT = True
ALLOW_UNAVAILABLE_MODEL_FALLBACK = False
INITIAL_TIMEOUT_SECONDS = 45
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 12_000_000
MAX_IMAGE_SIDE = 1280
MAX_TOTAL_DOWNLOAD_SECONDS = 35.0
MAX_SOURCE_IMAGES = 5
MAX_IMAGES_PER_CALL = 3
ALLOWED_IMAGE_HOSTS = frozenset({"res.cloudinary.com"})
ALLOWED_CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
COLOR_KEYS = (
    "white", "black", "gray", "silver", "beige", "transparent",
    "blue", "red", "other", "undetermined",
)
CONFIDENCE_KEYS = ("low", "medium", "high")
UNCERTAINTY_CODES = (
    "lighting", "glare", "partial_product", "background_dominant",
    "defect_mark_only", "multiple_products", "conflicting_images",
)
REVIEW_REASON_CODES = (
    "dictionary_unclassified", "classification_disagreement",
    "low_confidence", "needs_new_category", "master_color_missing",
    "master_color_mismatch", "visual_color_uncertain", "no_usable_image",
)


SYSTEM_PROMPT = """You audit one factory quality report using its raw text and attached photos.
Return only the JSON object required by the supplied schema.

Defect classification rules:
- Select only candidate indices supplied by the server. Never invent a key or label.
- Use the raw report text as the primary statement of what was reported. Photos may clarify it.
- If no candidate fits, select no false candidate and set needs_new_category=true.
- Do not calculate counts, rates, priorities, causes, machines, or production quantities.

Product body-colour rules:
- Judge the molded product's base body colour, not a defect mark, glare, background, label, fixture, or packaging.
- Chinese/Korean terms meaning white mark or whitening (for example 白印, 发白, 백화) describe a defect and do not prove that the product body is white.
- If the product body is not clearly visible, lighting is misleading, photos conflict, or only a defect close-up is shown, use undetermined and record uncertainty codes.
- Never infer or output a Part No. The server links the observation to the exact report Part No.

Reason internally but do not reveal chain-of-thought or free-form prose."""


def validate_job(job: dict[str, Any]) -> None:
    scope = job.get("scope") if isinstance(job.get("scope"), dict) else {}
    payload = (
        job.get("input_payload")
        if isinstance(job.get("input_payload"), dict)
        else {}
    )
    report = payload.get("report") if isinstance(payload.get("report"), dict) else {}
    candidates = payload.get("taxonomy_candidates")
    if (
        job.get("job_type") != "quality_image_analysis"
        or scope.get("mode") != MODE
        or scope.get("trigger") != TRIGGER
        or payload.get("source") != SOURCE
        or not isinstance(report.get("id"), int)
        or not isinstance(candidates, list)
        or not candidates
    ):
        raise ValueError("Invalid quality report taxonomy audit job contract.")


def build_dummy_result(
    job: dict[str, Any],
    model_name: str = "deterministic-local-worker",
) -> dict[str, Any]:
    return {
        "schema_version": WORKER_SCHEMA_VERSION,
        "defect_candidate_indices": [],
        "defect_confidence": "low",
        "needs_new_category": False,
        "evidence_basis": ["report_text"],
        "processed_images": [],
        "image_observations": [],
        "review_reason_codes": ["low_confidence"],
        "model_name": model_name,
        "source": "deterministic_unavailable",
    }


def _response_schema(candidate_count: int, image_count: int) -> dict[str, Any]:
    candidate_schema: dict[str, Any] = {"type": "integer", "minimum": 0}
    if candidate_count:
        candidate_schema["maximum"] = candidate_count - 1
    image_index_schema: dict[str, Any] = {"type": "integer", "minimum": 0}
    if image_count:
        image_index_schema["maximum"] = image_count - 1
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "defect_candidate_indices": {
                "type": "array",
                "items": candidate_schema,
                "maxItems": min(6, candidate_count),
            },
            "defect_confidence": {"type": "string", "enum": list(CONFIDENCE_KEYS)},
            "needs_new_category": {"type": "boolean"},
            "evidence_basis": {
                "type": "array",
                "items": {"type": "string", "enum": ["report_text", "image"]},
                "minItems": 1,
                "maxItems": 2,
            },
            "image_observations": {
                "type": "array",
                "minItems": image_count,
                "maxItems": image_count,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "image_index": image_index_schema,
                        "product_visible": {"type": "boolean"},
                        "body_color_key": {"type": "string", "enum": list(COLOR_KEYS)},
                        "confidence": {"type": "string", "enum": list(CONFIDENCE_KEYS)},
                        "uncertainty_codes": {
                            "type": "array",
                            "items": {"type": "string", "enum": list(UNCERTAINTY_CODES)},
                            "maxItems": 5,
                        },
                    },
                    "required": [
                        "image_index", "product_visible", "body_color_key",
                        "confidence", "uncertainty_codes",
                    ],
                },
            },
            "review_reason_codes": {
                "type": "array",
                "items": {"type": "string", "enum": list(REVIEW_REASON_CODES)},
                "maxItems": 8,
            },
        },
        "required": [
            "defect_candidate_indices", "defect_confidence",
            "needs_new_category", "evidence_basis", "image_observations",
            "review_reason_codes",
        ],
    }


def _download_image(
    url: str,
    *,
    max_bytes: int = MAX_IMAGE_BYTES,
    deadline: float | None = None,
) -> tuple[bytes, str]:
    max_bytes = max(1, min(int(max_bytes), MAX_IMAGE_BYTES))
    parsed = urlparse(str(url or ""))
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in ALLOWED_IMAGE_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in {None, 443}
    ):
        raise ValueError("Image URL is not an allowed Cloudinary HTTPS URL.")
    with requests.Session() as session:
        session.trust_env = False
        remaining_seconds = (
            max(0.1, deadline - time.monotonic())
            if deadline is not None
            else 15.0
        )
        if deadline is not None and remaining_seconds <= 0.1:
            raise ValueError("Image download deadline was exceeded.")
        with session.get(
            url,
            stream=True,
            allow_redirects=False,
            timeout=(min(5.0, remaining_seconds), min(15.0, remaining_seconds)),
            headers={"Accept": "image/jpeg,image/png,image/webp"},
        ) as response:
            response.raise_for_status()
            content_type = str(
                response.headers.get("Content-Type") or ""
            ).split(";", 1)[0].lower()
            if content_type not in ALLOWED_CONTENT_TYPES:
                raise ValueError("Remote content is not a supported image type.")
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > max_bytes:
                raise ValueError("Image exceeds the worker byte limit.")
            chunks: list[bytes] = []
            byte_count = 0
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if deadline is not None and time.monotonic() >= deadline:
                    raise ValueError("Image download deadline was exceeded.")
                if not chunk:
                    continue
                byte_count += len(chunk)
                if byte_count > max_bytes:
                    raise ValueError("Image exceeds the worker byte limit.")
                chunks.append(chunk)
    content = b"".join(chunks)
    if not content:
        raise ValueError("Image download returned an empty body.")
    return content, hashlib.sha256(content).hexdigest()


def _normalize_image(content: bytes, target_path: Path) -> None:
    try:
        with Image.open(BytesIO(content)) as source:
            width, height = source.size
            if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                raise ValueError("Image dimensions exceed the worker limit.")
            source.load()
            image = ImageOps.exif_transpose(source).convert("RGB")
            image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
            image.save(target_path, format="JPEG", quality=88, optimize=True)
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError) as exc:
        raise ValueError("Remote content could not be decoded as an image.") from exc


def _validate_model_result(
    result: Any,
    *,
    candidate_count: int,
    image_count: int,
) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ValueError("Qwen result is not an object.")
    indices = result.get("defect_candidate_indices")
    observations = result.get("image_observations")
    if not isinstance(indices, list) or not isinstance(observations, list):
        raise ValueError("Qwen result is missing bounded arrays.")
    if any(type(value) is not int or value < 0 or value >= candidate_count for value in indices):
        raise ValueError("Qwen selected an invalid taxonomy candidate.")
    if len(indices) != len(set(indices)) or len(indices) > 6:
        raise ValueError("Qwen returned duplicate or excessive taxonomy candidates.")
    if result.get("defect_confidence") not in CONFIDENCE_KEYS:
        raise ValueError("Qwen returned an invalid confidence value.")
    evidence_basis = result.get("evidence_basis")
    if (
        not isinstance(evidence_basis, list)
        or not evidence_basis
        or any(value not in {"report_text", "image"} for value in evidence_basis)
        or len(evidence_basis) != len(set(evidence_basis))
        or len(evidence_basis) > 2
    ):
        raise ValueError("Qwen returned an invalid evidence basis.")
    if image_count == 0 and "image" in evidence_basis:
        raise ValueError("Qwen claimed image evidence without an image.")
    if len(observations) != image_count:
        raise ValueError("Qwen must return one observation for every processed image.")
    seen_images: set[int] = set()
    for row in observations:
        if not isinstance(row, dict):
            raise ValueError("Qwen returned an invalid image observation.")
        image_index = row.get("image_index")
        if type(image_index) is not int or image_index < 0 or image_index >= image_count:
            raise ValueError("Qwen referenced an unavailable image.")
        if image_index in seen_images:
            raise ValueError("Qwen returned duplicate image observations.")
        seen_images.add(image_index)
        if type(row.get("product_visible")) is not bool:
            raise ValueError("Qwen product visibility is invalid.")
        if row.get("body_color_key") not in COLOR_KEYS:
            raise ValueError("Qwen returned an invalid body colour.")
        if (
            row.get("product_visible") is False
            and row.get("body_color_key") != "undetermined"
        ):
            raise ValueError("Qwen assigned a colour to an invisible product.")
        if row.get("confidence") not in CONFIDENCE_KEYS:
            raise ValueError("Qwen returned an invalid image confidence.")
        codes = row.get("uncertainty_codes")
        if (
            not isinstance(codes, list)
            or any(code not in UNCERTAINTY_CODES for code in codes)
            or len(codes) != len(set(codes))
            or len(codes) > 5
        ):
            raise ValueError("Qwen returned an invalid uncertainty code.")
    if seen_images != set(range(image_count)):
        raise ValueError("Qwen omitted a processed image observation.")
    review_codes = result.get("review_reason_codes")
    if (
        not isinstance(review_codes, list)
        or any(code not in REVIEW_REASON_CODES for code in review_codes)
        or len(review_codes) != len(set(review_codes))
        or len(review_codes) > 8
    ):
        raise ValueError("Qwen returned an invalid review reason.")
    if type(result.get("needs_new_category")) is not bool:
        raise ValueError("Qwen needs_new_category is invalid.")
    return result


def analyze_with_llm(
    job: dict[str, Any],
    llm: Any,
    model_name: str,
    deterministic: dict[str, Any],
) -> dict[str, Any]:
    validate_job(job)
    payload = job["input_payload"]
    report = payload["report"]
    candidates = payload["taxonomy_candidates"]
    image_refs = [
        row for row in report.get("image_refs") or []
        if isinstance(row, dict) and row.get("slot") and row.get("url")
    ][:MAX_SOURCE_IMAGES]
    processed: list[dict[str, str]] = []

    with tempfile.TemporaryDirectory(prefix="wj-quality-audit-") as temporary_dir:
        image_paths: list[str] = []
        total_bytes = 0
        download_deadline = time.monotonic() + MAX_TOTAL_DOWNLOAD_SECONDS
        for image_ref in image_refs:
            remaining_bytes = MAX_TOTAL_IMAGE_BYTES - total_bytes
            if remaining_bytes <= 0:
                break
            try:
                content, digest = _download_image(
                    str(image_ref["url"]),
                    max_bytes=remaining_bytes,
                    deadline=download_deadline,
                )
                path = Path(temporary_dir) / f"{len(image_paths)}.jpg"
                _normalize_image(content, path)
            except (requests.RequestException, ValueError, OSError):
                continue
            total_bytes += len(content)
            image_paths.append(str(path))
            processed.append({"slot": str(image_ref["slot"]), "sha256": digest})

        prompt_report = {
            key: report.get(key)
            for key in (
                "report_dt", "section",
                "phenomenon", "disposition", "action_result",
            )
        }
        taxonomy_payload = [
            {
                "candidate_index": index,
                "key_hint": row.get("key"),
                "parent_key_hint": row.get("parent_key"),
                "label": row.get("label"),
                "source_terms": row.get("source_terms") or [],
            }
            for index, row in enumerate(candidates)
        ]
        call_ranges = (
            range(0, len(image_paths), MAX_IMAGES_PER_CALL)
            if image_paths
            else (0,)
        )
        validated_calls: list[dict[str, Any]] = []
        for start in call_ranges:
            call_paths = image_paths[start:start + MAX_IMAGES_PER_CALL]
            call_processed = processed[start:start + MAX_IMAGES_PER_CALL]
            result = llm.structured_analysis(
                SYSTEM_PROMPT,
                {
                    "report": prompt_report,
                    "taxonomy_candidates": taxonomy_payload,
                    "image_slots_in_order": [row["slot"] for row in call_processed],
                    "call_purpose": (
                        "classify_report_and_observe_images"
                        if not validated_calls
                        else "observe_remaining_images"
                    ),
                },
                enable_thinking=False,
                timeout_seconds=INITIAL_TIMEOUT_SECONDS,
                max_tokens=384,
                json_schema=_response_schema(len(candidates), len(call_processed)),
                image_urls=call_paths,
            )
            validated = _validate_model_result(
                result,
                candidate_count=len(candidates),
                image_count=len(call_processed),
            )
            validated["image_observations"] = [
                {**observation, "image_index": observation["image_index"] + start}
                for observation in validated["image_observations"]
            ]
            validated_calls.append(validated)

    primary = validated_calls[0]
    image_observations = [
        observation
        for result in validated_calls
        for observation in result["image_observations"]
    ]
    evidence_basis = list(primary["evidence_basis"])
    if len(validated_calls) > 1 and image_observations and "image" not in evidence_basis:
        evidence_basis.append("image")
    review_reason_codes = list(dict.fromkeys(
        code
        for result in validated_calls
        for code in result["review_reason_codes"]
    ))
    if any(
        set(result["defect_candidate_indices"])
        != set(primary["defect_candidate_indices"])
        for result in validated_calls[1:]
    ) and "classification_disagreement" not in review_reason_codes:
        review_reason_codes.append("classification_disagreement")
    if any(
        result["needs_new_category"] is True
        for result in validated_calls[1:]
    ) and "needs_new_category" not in review_reason_codes:
        review_reason_codes.append("needs_new_category")
    review_reason_codes = review_reason_codes[:8]
    confidence_order = {"low": 0, "medium": 1, "high": 2}
    defect_confidence = min(
        (result["defect_confidence"] for result in validated_calls),
        key=lambda value: confidence_order[value],
    )
    needs_new_category = any(
        result["needs_new_category"] is True for result in validated_calls
    )
    return {
        "schema_version": WORKER_SCHEMA_VERSION,
        "defect_candidate_indices": primary["defect_candidate_indices"],
        "defect_confidence": defect_confidence,
        "needs_new_category": needs_new_category,
        "evidence_basis": evidence_basis,
        "image_observations": image_observations,
        "review_reason_codes": review_reason_codes,
        "processed_images": processed,
        "model_name": model_name,
        "source": "local_qwen38_multimodal",
        "llm_fallback": False,
    }
