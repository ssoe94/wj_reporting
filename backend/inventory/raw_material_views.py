"""HTTP endpoint for the live raw-material overview."""

from __future__ import annotations

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from inventory.services.raw_materials import build_raw_material_overview


MAX_WAREHOUSE_SELECTION = 50
MAX_WAREHOUSE_CODE_LENGTH = 100


def _warehouse_codes(query_params) -> list[str]:
    values: list[str] = []
    for key in ("warehouse_code", "warehouse_codes"):
        for raw in query_params.getlist(key):
            for code in raw.split(","):
                code = code.strip()
                if len(code) > MAX_WAREHOUSE_CODE_LENGTH:
                    raise ValueError(
                        f"warehouse code must not exceed {MAX_WAREHOUSE_CODE_LENGTH} characters."
                    )
                if code and code not in values:
                    values.append(code)
                    if len(values) > MAX_WAREHOUSE_SELECTION:
                        raise ValueError(
                            f"at most {MAX_WAREHOUSE_SELECTION} warehouses may be selected."
                        )
    return values


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


def _truthy(value) -> bool:
    return str(value or "").strip().casefold() in {"1", "true", "yes", "on"}


class RawMaterialOverviewView(APIView):
    """Return current stock, usage trend, and transparent reorder guidance."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            warehouse_codes = _warehouse_codes(request.query_params)
            lookback_days = _bounded_int(request.query_params, "lookback_days", 30, 7, 90)
            lead_time_days = _bounded_int(request.query_params, "lead_time_days", 14, 1, 180)
            review_period_days = _bounded_int(
                request.query_params, "review_period_days", 7, 0, 90
            )
        except ValueError as exc:
            return Response(
                {"error": str(exc)}, status=status.HTTP_400_BAD_REQUEST
            )

        payload = build_raw_material_overview(
            warehouse_codes=warehouse_codes,
            lookback_days=lookback_days,
            lead_time_days=lead_time_days,
            review_period_days=review_period_days,
            force_refresh=_truthy(request.query_params.get("refresh")),
        )
        response = Response(payload)
        response["Cache-Control"] = "private, no-store"
        response["Pragma"] = "no-cache"
        return response


__all__ = ["RawMaterialOverviewView"]
