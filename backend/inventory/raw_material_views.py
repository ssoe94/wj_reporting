"""HTTP endpoints for the stored raw-material report and controlled MES sync."""

from __future__ import annotations

import hashlib
import json

from django.core.cache import cache
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from inventory.models import RawMaterialSyncState
from inventory.services.raw_materials import (
    CANONICAL_RAW_MATERIAL_UNIT,
    build_raw_material_overview,
    build_raw_material_stock_detail_page,
)
from inventory.services.raw_material_sync import (
    claim_raw_material_sync,
    fail_claimed_raw_material_sync,
    get_raw_material_sync_status,
    launch_claimed_raw_material_sync,
)


# The key includes the durable sync generation, so a new daily/manual sync
# invalidates immediately while identical reports are computed at most daily.
OVERVIEW_CACHE_SECONDS = 25 * 60 * 60


def _overview_cache_key(parameters: dict) -> str:
    sync_updated_at = (
        RawMaterialSyncState.objects.filter(pk=RawMaterialSyncState.SINGLETON_PK)
        .values_list("updated_at", flat=True)
        .first()
    )
    payload = {
        **parameters,
        "sync_updated_at": sync_updated_at.isoformat() if sync_updated_at else None,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"raw-materials:stored-overview:v5:{digest}"


def _stock_detail_cache_key(parameters: dict) -> str:
    sync_updated_at = (
        RawMaterialSyncState.objects.filter(pk=RawMaterialSyncState.SINGLETON_PK)
        .values_list("updated_at", flat=True)
        .first()
    )
    payload = {
        **parameters,
        "sync_updated_at": sync_updated_at.isoformat() if sync_updated_at else None,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"raw-materials:stored-stock-details:v1:{digest}"


def _bounded_int(query_params, key: str, default: int, minimum: int, maximum: int) -> int:
    raw = query_params.get(key)
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be an integer.") from exc
    if value < minimum or value > maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}.")
    return value


class RawMaterialOverviewView(APIView):
    """Return the latest saved report without contacting MES in the request."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            lookback_days = _bounded_int(request.query_params, "lookback_days", 30, 7, 30)
            lead_time_days = _bounded_int(request.query_params, "lead_time_days", 14, 1, 180)
            review_period_days = _bounded_int(
                request.query_params, "review_period_days", 14, 0, 90
            )
        except ValueError as exc:
            return Response(
                {"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST
            )

        parameters = {
            "lookback_days": lookback_days,
            "lead_time_days": lead_time_days,
            "review_period_days": review_period_days,
        }
        cache_key = _overview_cache_key(parameters)
        payload = cache.get(cache_key)
        if not isinstance(payload, dict):
            payload = build_raw_material_overview(
                lookback_days=lookback_days,
                lead_time_days=lead_time_days,
                review_period_days=review_period_days,
                prefer_stored=True,
            )
            cache.set(cache_key, payload, OVERVIEW_CACHE_SECONDS)
        response = Response(payload)
        response["Cache-Control"] = "private, no-store"
        response["Pragma"] = "no-cache"
        return response


class RawMaterialStockDetailView(APIView):
    """Return one bounded detail page from the latest saved inventory."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        group_key = str(request.query_params.get("group_key") or "").strip()
        unit = str(
            request.query_params.get("unit") or CANONICAL_RAW_MATERIAL_UNIT
        ).strip()
        if not group_key or len(group_key) > 300:
            return Response(
                {"error": "group_key is required and must be at most 300 characters."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if unit.casefold() != CANONICAL_RAW_MATERIAL_UNIT:
            return Response(
                {"error": "unit must be kg."}, status=status.HTTP_400_BAD_REQUEST
            )
        try:
            page = _bounded_int(request.query_params, "page", 1, 1, 100_000)
            page_size = _bounded_int(
                request.query_params, "page_size", 100, 1, 200
            )
        except ValueError as exc:
            return Response(
                {"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST
            )

        parameters = {
            "group_key": group_key,
            "unit": CANONICAL_RAW_MATERIAL_UNIT,
            "page": page,
            "page_size": page_size,
        }
        cache_key = _stock_detail_cache_key(parameters)
        payload = cache.get(cache_key)
        if not isinstance(payload, dict):
            payload = build_raw_material_stock_detail_page(**parameters)
            cache.set(cache_key, payload, OVERVIEW_CACHE_SECONDS)
        response = Response(payload)
        response["Cache-Control"] = "private, no-store"
        response["Pragma"] = "no-cache"
        return response


class RawMaterialSyncView(APIView):
    """Start one exceptional background sync or return its durable status."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(get_raw_material_sync_status())

    def post(self, request):
        if not request.user.is_staff:
            return Response(
                {"error": "Only staff users may start a manual MES update."},
                status=status.HTTP_403_FORBIDDEN,
            )
        claimed, sync_state = claim_raw_material_sync("manual")
        if not claimed:
            return Response(sync_state, status=status.HTTP_409_CONFLICT)

        try:
            launch_claimed_raw_material_sync(
                trigger="manual",
                claimed_started_at=sync_state["started_at"],
            )
        except Exception as exc:
            failed = fail_claimed_raw_material_sync(
                f"MES update worker could not start: {exc.__class__.__name__}",
                claimed_started_at=sync_state["started_at"],
            )
            return Response(failed, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(sync_state, status=status.HTTP_202_ACCEPTED)


__all__ = [
    "RawMaterialOverviewView",
    "RawMaterialStockDetailView",
    "RawMaterialSyncView",
]
