"""Snapshot-first endpoints for the BLACKLAKE mould dashboard.

The integration service intentionally keeps a richer normalized payload for
server-side diagnostics.  These views expose only the fields required by the
public dashboard so raw BLACKLAKE data, provenance, file identifiers, and
people identifiers never cross the anonymous API boundary.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from typing import Any

from django.core.cache import cache
from django.db import close_old_connections, transaction
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from .mould_service import (
    MouldServiceError,
    build_mould_board,
    build_mould_detail,
    unavailable_board_payload,
    unavailable_detail_payload,
)
from .mould_snapshots import (
    BOARD_SNAPSHOT_KEY,
    SHOT_MILESTONE_SIZE,
    claim_refresh,
    decorate_board_payload,
    decorate_detail_payload,
    detail_snapshot_key,
    mark_snapshot_freshness,
    release_refresh,
    snapshot_is_stale,
    store_snapshot,
    usage_shot_count,
)
from .models import MouldDataSnapshot, MouldUsageConfirmation
from .mould_machine_validations import (
    VALIDATION_ALGORITHM_VERSION,
    MouldMachineValidationError,
    delete_validation_rule,
    list_validation_rules,
    save_validation_rule,
)
from .permissions import InjectionPermission


_SUMMARY_FIELDS = (
    "total",
    "mounted",
    "stored",
    "maintenance",
    "repair",
    "offsite",
    "unknown",
    "conflicts",
)
_LOCATION_FIELDS = (
    "code",
    "label",
    "kind",
    "machine_number",
    "parent_code",
    "parent_label",
    "zone_code",
    "zone_label",
    "level",
    "mould_count",
    "conflict",
)
_MACHINE_FIELDS = (
    "number",
    "location_code",
    "label",
    "tonnage",
    "mould_count",
    "conflict",
)
_MOULD_FIELDS = (
    "instance_id",
    "mould_code",
    "asset_code",
    "name",
    "drawing_no",
    "model",
    "status",
    "classification",
    "cavity_count",
    "manufacturer",
    "acquired_at",
    "serial_no",
    "current_output_amount",
    "current_output_batch_amount",
    "lifespan_status",
    "maintenance_status",
    "repair_status",
    "summary_category",
    "location",
    "final_changed_at",
    "record_updated_at",
    "position_changed_at",
    "time_quality",
    "last_used_at",
    "last_used_source",
    "inactivity_reference_at",
    "inactivity_reference_source",
    "inactivity_months",
    "inactivity_tier",
    "shot_milestone",
    "shot_milestone_level",
    "pending_milestone",
    "confirmed_milestone",
    "confirmation_required",
    "detail_snapshot_available",
)
_ENUM_FIELDS = ("code", "label", "message", "name")
_DATA_FRESHNESS_FIELDS = (
    "status",
    "fetched_at",
    "source_latest_at",
    "snapshot_at",
    "stale",
)
_MOVEMENT_FIELDS = (
    "id",
    "occurred_at",
    "from_location",
    "to_location",
    "reason",
    "time_quality",
)
_PRODUCTION_FIELDS = (
    "id",
    "period",
    "year",
    "month",
    "quantity",
    "cumulative_quantity",
    "source_cumulative_quantity",
    "cumulative_basis",
    "unit",
    "recorded_at",
)
_REPAIR_FIELDS = (
    "id",
    "record_code",
    "requested_at",
    "started_at",
    "finished_at",
    "type",
    "content",
    "vendor",
    "cumulative_output_amount",
)
_PUBLIC_BOARD_CACHE_SECONDS = 45
_PUBLIC_DETAIL_CACHE_SECONDS = 45
_SNAPSHOT_REFRESH_POOL = ThreadPoolExecutor(
    max_workers=2,
    thread_name_prefix="mould-snapshot",
)


def _public_cache_key(namespace: str, value: str) -> str:
    digest = sha256(value.encode("utf-8")).hexdigest()
    return f"injection:moulds:public:{namespace}:v1:{digest}"


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _project_fields(value: Any, allowed_fields: Sequence[str]) -> dict[str, Any]:
    source = _mapping(value)
    return {field: source[field] for field in allowed_fields if field in source}


def _project_rows(value: Any, allowed_fields: Sequence[str]) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        _project_fields(item, allowed_fields)
        for item in value
        if isinstance(item, Mapping)
    ]


def _project_enum(value: Any) -> Any:
    if isinstance(value, Mapping):
        return _project_fields(value, _ENUM_FIELDS)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _public_display_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        for key in (
            "mainProperty",
            "$primaryValue",
            "choiceValue",
            "label",
            "message",
            "name",
        ):
            candidate = value.get(key)
            if candidate is None or isinstance(candidate, (str, int, float, bool)):
                if candidate not in (None, ""):
                    return candidate
        return None
    if isinstance(value, Sequence) and not isinstance(
        value, (str, bytes, bytearray)
    ):
        displayed = [
            item
            for item in (_public_display_value(child) for child in value)
            if item not in (None, "")
        ]
        return ", ".join(str(item) for item in displayed) if displayed else None
    return None


def _project_location(value: Any) -> dict[str, Any]:
    projected = _project_fields(value, _LOCATION_FIELDS)
    for field in (
        "code",
        "label",
        "kind",
        "parent_code",
        "parent_label",
        "zone_code",
        "zone_label",
    ):
        if field in projected:
            projected[field] = _public_display_value(projected[field])
    return projected


def _project_mould(value: Any) -> dict[str, Any]:
    projected = _project_fields(value, _MOULD_FIELDS)
    for field in (
        "instance_id",
        "mould_code",
        "asset_code",
        "name",
        "drawing_no",
        "model",
        "manufacturer",
        "serial_no",
        "summary_category",
        "final_changed_at",
        "record_updated_at",
        "position_changed_at",
        "time_quality",
    ):
        if field in projected:
            projected[field] = _public_display_value(projected[field])
    for field in (
        "status",
        "classification",
        "manufacturer",
        "lifespan_status",
        "maintenance_status",
        "repair_status",
    ):
        if field in projected:
            projected[field] = _project_enum(projected[field])
    projected["location"] = _project_location(projected.get("location"))
    return projected


def _project_board_payload(payload: Any) -> dict[str, Any]:
    source = _mapping(payload)
    return {
        "summary": _project_fields(source.get("summary"), _SUMMARY_FIELDS),
        "locations": _project_rows(source.get("locations"), _LOCATION_FIELDS),
        "machines": _project_rows(source.get("machines"), _MACHINE_FIELDS),
        "moulds": [
            _project_mould(item)
            for item in source.get("moulds", [])
            if isinstance(item, Mapping)
        ] if isinstance(source.get("moulds"), Sequence) else [],
        "final_changed_at": source.get("final_changed_at"),
        "data_freshness": _project_fields(
            source.get("data_freshness"),
            _DATA_FRESHNESS_FIELDS,
        ),
    }


def _project_detail_payload(payload: Any) -> dict[str, Any]:
    source = _mapping(payload)
    return {
        "mould": _project_mould(source.get("mould")),
        "movement_history": _project_rows(
            source.get("movement_history"),
            _MOVEMENT_FIELDS,
        ),
        "production_history": _project_rows(
            source.get("production_history"),
            _PRODUCTION_FIELDS,
        ),
        "repair_history": _project_rows(
            source.get("repair_history"),
            _REPAIR_FIELDS,
        ),
        "final_changed_at": source.get("final_changed_at"),
        "record_updated_at": source.get("record_updated_at"),
        "position_changed_at": source.get("position_changed_at"),
        "time_quality": source.get("time_quality"),
        "data_freshness": _project_fields(
            source.get("data_freshness"),
            _DATA_FRESHNESS_FIELDS,
        ),
    }


def _no_store_response(payload, *, status_code=status.HTTP_200_OK):
    response = Response(payload, status=status_code)
    response["Cache-Control"] = "no-store"
    response["Pragma"] = "no-cache"
    return response


def _refresh_board_snapshot() -> dict[str, Any]:
    projected = _project_board_payload(build_mould_board())
    store_snapshot(
        snapshot_key=BOARD_SNAPSHOT_KEY,
        kind=MouldDataSnapshot.KIND_BOARD,
        payload=projected,
    )
    return projected


def _refresh_detail_snapshot(instance_id: str) -> dict[str, Any]:
    projected = _project_detail_payload(build_mould_detail(instance_id))
    store_snapshot(
        snapshot_key=detail_snapshot_key(instance_id),
        kind=MouldDataSnapshot.KIND_DETAIL,
        instance_id=instance_id,
        payload=projected,
    )
    return projected


def _run_background_refresh(snapshot_key: str, refresh) -> None:
    close_old_connections()
    try:
        refresh()
    except Exception as exc:  # Keep serving the last known-good snapshot.
        release_refresh(snapshot_key, str(exc))
    finally:
        close_old_connections()


def _schedule_refresh(snapshot_key: str, refresh) -> bool:
    if not claim_refresh(snapshot_key):
        return False
    _SNAPSHOT_REFRESH_POOL.submit(
        _run_background_refresh,
        snapshot_key,
        refresh,
    )
    return True


class MouldBoardView(APIView):
    """Return the public dashboard projection without exposing MES credentials."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        quick_search = str(request.query_params.get("q") or "").strip()
        if len(quick_search) > 120:
            return _no_store_response(
                {"detail": "q must be at most 120 characters."},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        if not quick_search:
            snapshot = MouldDataSnapshot.objects.filter(
                snapshot_key=BOARD_SNAPSHOT_KEY,
            ).first()
            if snapshot is not None:
                refreshing = False
                if snapshot_is_stale(snapshot):
                    refreshing = _schedule_refresh(
                        BOARD_SNAPSHOT_KEY,
                        _refresh_board_snapshot,
                    )
                payload = decorate_board_payload(snapshot.payload)
                payload = mark_snapshot_freshness(
                    payload,
                    snapshot,
                    refreshing=refreshing or bool(snapshot.refresh_started_at),
                )
                return _no_store_response(payload)
        cache_key = _public_cache_key("board", quick_search.casefold())
        cached_payload = cache.get(cache_key)
        if isinstance(cached_payload, Mapping):
            return _no_store_response(dict(cached_payload))
        try:
            payload = build_mould_board(quick_search=quick_search)
        except MouldServiceError as exc:
            payload = unavailable_board_payload(str(exc))
            return _no_store_response(
                _project_board_payload(payload),
                status_code=status.HTTP_502_BAD_GATEWAY,
            )
        projected_payload = _project_board_payload(payload)
        if not quick_search:
            store_snapshot(
                snapshot_key=BOARD_SNAPSHOT_KEY,
                kind=MouldDataSnapshot.KIND_BOARD,
                payload=projected_payload,
            )
            projected_payload = decorate_board_payload(projected_payload)
        cache.set(
            cache_key,
            projected_payload,
            timeout=_PUBLIC_BOARD_CACHE_SECONDS,
        )
        return _no_store_response(projected_payload)


class MouldDetailView(APIView):
    """Return the public detail projection for one mould."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, instance_id, *args, **kwargs):
        instance_id = str(instance_id or "").strip()
        snapshot_key = detail_snapshot_key(instance_id)
        snapshot = MouldDataSnapshot.objects.filter(
            snapshot_key=snapshot_key,
        ).first()
        if snapshot is not None:
            refreshing = False
            if snapshot_is_stale(snapshot):
                refreshing = _schedule_refresh(
                    snapshot_key,
                    lambda: _refresh_detail_snapshot(instance_id),
                )
            payload = decorate_detail_payload(snapshot.payload)
            payload = mark_snapshot_freshness(
                payload,
                snapshot,
                refreshing=refreshing or bool(snapshot.refresh_started_at),
            )
            return _no_store_response(payload)
        cache_key = _public_cache_key("detail", instance_id)
        cached_payload = cache.get(cache_key)
        if isinstance(cached_payload, Mapping):
            return _no_store_response(dict(cached_payload))
        try:
            payload = build_mould_detail(instance_id)
        except ValueError as exc:
            return _no_store_response(
                {"detail": str(exc)},
                status_code=status.HTTP_400_BAD_REQUEST,
            )
        except MouldServiceError as exc:
            payload = unavailable_detail_payload(instance_id, str(exc))
            return _no_store_response(
                _project_detail_payload(payload),
                status_code=status.HTTP_502_BAD_GATEWAY,
            )
        projected_payload = _project_detail_payload(payload)
        store_snapshot(
            snapshot_key=snapshot_key,
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id=instance_id,
            payload=projected_payload,
        )
        projected_payload = decorate_detail_payload(projected_payload)
        cache.set(
            cache_key,
            projected_payload,
            timeout=_PUBLIC_DETAIL_CACHE_SECONDS,
        )
        return _no_store_response(projected_payload)


class MouldUsageConfirmationView(APIView):
    """Acknowledge a reached 100k-shot checkpoint with an authenticated audit trail."""

    permission_classes = [InjectionPermission]

    def post(self, request, instance_id, *args, **kwargs):
        instance_id = str(instance_id or "").strip()
        if not instance_id.isdigit():
            return Response(
                {"detail": "Invalid mould instance id."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        snapshot = MouldDataSnapshot.objects.filter(
            snapshot_key=detail_snapshot_key(instance_id),
        ).first()
        if snapshot is None:
            return Response(
                {"detail": "금형 상세 스냅샷을 먼저 불러와 주세요."},
                status=status.HTTP_409_CONFLICT,
            )
        mould = snapshot.payload.get("mould")
        if not isinstance(mould, Mapping):
            return Response(
                {"detail": "금형 형합수 정보를 확인할 수 없습니다."},
                status=status.HTTP_409_CONFLICT,
            )
        shot_count = usage_shot_count(
            current_output_amount=mould.get("current_output_amount"),
            production_history=snapshot.payload.get("production_history"),
        )
        if shot_count <= 0:
            return Response(
                {"detail": "금형 형합수가 등록되지 않았습니다."},
                status=status.HTTP_409_CONFLICT,
            )
        reached = (shot_count // SHOT_MILESTONE_SIZE) * SHOT_MILESTONE_SIZE
        raw_milestone = request.data.get("milestone_shots", reached)
        try:
            milestone = int(raw_milestone)
        except (TypeError, ValueError):
            milestone = 0
        if (
            milestone < SHOT_MILESTONE_SIZE
            or milestone % SHOT_MILESTONE_SIZE != 0
            or milestone > reached
        ):
            return Response(
                {"detail": "현재 도달한 10만 Shot 단위만 확인할 수 있습니다."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        with transaction.atomic():
            confirmation, created = MouldUsageConfirmation.objects.get_or_create(
                mould_instance_id=instance_id,
                milestone_shots=milestone,
                defaults={
                    "shot_count_at_confirmation": shot_count,
                    "confirmed_by": request.user,
                    "note": str(request.data.get("note") or "").strip()[:240],
                },
            )
        decorated = decorate_detail_payload(snapshot.payload)
        return Response(
            {
                "created": created,
                "confirmation": {
                    "milestone_shots": confirmation.milestone_shots,
                    "shot_count_at_confirmation": confirmation.shot_count_at_confirmation,
                    "confirmed_at": confirmation.confirmed_at,
                    "confirmed_by": confirmation.confirmed_by.get_username(),
                },
                "mould": decorated.get("mould", {}),
            },
            status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        )


class MouldMachineValidationRuleView(APIView):
    """Share reusable dashboard judgements while keeping writes permission-bound."""

    def get_permissions(self):
        if self.request.method == "GET":
            return [AllowAny()]
        return [InjectionPermission()]

    def get(self, request, *args, **kwargs):
        return _no_store_response({
            "algorithm_version": VALIDATION_ALGORITHM_VERSION,
            "rules": list_validation_rules(),
        })

    def post(self, request, *args, **kwargs):
        action = str(request.data.get("action") or "confirm").strip().lower()
        try:
            if action == "reset":
                rule_key, deleted = delete_validation_rule(request.data, user=request.user)
                return _no_store_response({
                    "algorithm_version": VALIDATION_ALGORITHM_VERSION,
                    "rule_key": rule_key,
                    "deleted": deleted,
                })
            if action != "confirm":
                return _no_store_response(
                    {"detail": "Unsupported action."},
                    status_code=status.HTTP_400_BAD_REQUEST,
                )
            rule = save_validation_rule(request.data, user=request.user)
        except MouldMachineValidationError as exc:
            return _no_store_response(
                {"detail": str(exc)},
                status_code=exc.status_code,
            )
        return _no_store_response(
            {
                "algorithm_version": VALIDATION_ALGORITHM_VERSION,
                "rule": rule,
            },
            status_code=status.HTTP_201_CREATED if rule["revision"] == 1 else status.HTTP_200_OK,
        )


__all__ = [
    "MouldBoardView",
    "MouldDetailView",
    "MouldMachineValidationRuleView",
    "MouldUsageConfirmationView",
]
