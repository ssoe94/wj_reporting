from __future__ import annotations

import json
import re
from datetime import timedelta

import cloudinary.utils
from django.core.cache import cache
from django.db import transaction
from django.urls import reverse
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from injection.permissions import DevelopmentPermission, InjectionPermission

from .models import InjectionDowntimeConfirmation
from .serializers import InjectionDowntimeConfirmationSerializer
from .ai_metrics import SHANGHAI_TZ, business_range
from .ai_retrievers import get_injection_summary

from .field_kanban import (
    FieldKanbanError,
    apply_field_material_conversion_notification,
    build_field_kanban_snapshot,
    build_field_material_readiness,
    current_shanghai_business_date,
    repair_field_material_preview,
    save_defect_checkpoint,
    save_field_material,
    share_existing_field_material,
)


FIELD_TERMINAL_USERNAME_RE = re.compile(r"^imm(\d{2})$", re.IGNORECASE)


def field_terminal_machine_number(user) -> int | None:
    username = str(getattr(user, "username", "") or "")
    match = FIELD_TERMINAL_USERNAME_RE.fullmatch(username)
    return int(match.group(1)) if match else None


class FieldWriteProfileRequired(BasePermission):
    """Keep field material reads and field writes fail-closed without a profile."""

    def has_permission(self, request, view):
        if getattr(request.user, "is_staff", False):
            return True
        try:
            has_profile = bool(request.user.profile.pk)
        except Exception:
            return False
        return has_profile


def _target_date(value):
    if value in (None, ""):
        return current_shanghai_business_date()
    parsed = parse_date(str(value))
    if parsed is None:
        raise FieldKanbanError(
            "Invalid date format. Use YYYY-MM-DD.",
            code="invalid_date",
        )
    return parsed


def _machine_number(value) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise FieldKanbanError(
            "machine_number must be between 1 and 17.",
            code="invalid_machine_number",
        ) from exc
    if not 1 <= number <= 17:
        raise FieldKanbanError(
            "machine_number must be between 1 and 17.",
            code="invalid_machine_number",
        )
    return number


def _enforce_terminal_machine_scope(request, machine_number: int) -> None:
    assigned_machine = field_terminal_machine_number(request.user)
    if assigned_machine is not None and assigned_machine != machine_number:
        raise FieldKanbanError(
            "A field terminal can only access its assigned injection machine.",
            code="field_terminal_machine_mismatch",
            status_code=403,
        )


def _error_response(exc: FieldKanbanError) -> Response:
    return Response(
        {"detail": exc.detail, "code": exc.code},
        status=exc.status_code,
    )


def _query_bool(value, *, default: bool = True) -> bool:
    if value in (None, ""):
        return default
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


class FieldKanbanView(APIView):
    # The machine kanban is mounted on unattended shop-floor displays.  Keep
    # this read-only snapshot public. Field-only mutations use separate,
    # narrowly validated endpoints; document administration remains protected.
    # Disabling authentication here also prevents a stale bearer token stored
    # by an old terminal session from turning an otherwise public request into
    # a 401.
    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        try:
            target_date = _target_date(request.query_params.get("date"))
            machine_number = _machine_number(request.query_params.get("machine_number"))
            snapshot = build_field_kanban_snapshot(
                target_date,
                machine_number,
                include_quality=_query_bool(
                    request.query_params.get("include_quality")
                ),
            )

            # Operator usernames are not needed by the display and should not
            # be exposed through its public endpoint.  Copy the nested mapping
            # so a cached snapshot is never mutated in place.
            latest_confirmation = snapshot.get("latest_confirmation")
            if isinstance(latest_confirmation, dict):
                snapshot = dict(snapshot)
                snapshot["latest_confirmation"] = {
                    key: value
                    for key, value in latest_confirmation.items()
                    if key != "confirmed_by"
                }

            return Response(snapshot)
        except FieldKanbanError as exc:
            return _error_response(exc)


class FieldDefectCheckpointView(APIView):
    # This endpoint is intentionally limited to the validated field-checkpoint
    # payload. It is public for unattended terminals; broader production edits
    # and document administration remain authenticated below.
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request, *args, **kwargs):
        try:
            target_date = _target_date(request.data.get("business_date"))
            machine_number = _machine_number(request.data.get("machine_number"))
            checkpoint, created = save_defect_checkpoint(
                target_date=target_date,
                machine_number=machine_number,
                event_key=request.data.get("event_key"),
                trigger=request.data.get("trigger"),
                items=request.data.get("items", []),
                plan_id=request.data.get("plan_id"),
                part_no=request.data.get("part_no", ""),
                sequence=request.data.get("sequence"),
                user=None,
            )
            return Response(
                {"checkpoint": checkpoint, "created": created},
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )
        except FieldKanbanError as exc:
            return _error_response(exc)


def _field_machine_keys(machine_number: int) -> list[str]:
    return [
        str(machine_number),
        f"{machine_number:02d}",
        f"{machine_number}호기",
        f"{machine_number}号机",
    ]


class FieldDowntimeConfirmationView(APIView):
    """Read and save one machine's model-change decisions from a field panel."""

    authentication_classes = []
    permission_classes = [AllowAny]
    parser_classes = [JSONParser]

    def get(self, request, *args, **kwargs):
        try:
            target_date = _target_date(request.query_params.get("date"))
            machine_number = _machine_number(
                request.query_params.get("machine_number")
            )
        except FieldKanbanError as exc:
            return _error_response(exc)

        confirmations = InjectionDowntimeConfirmation.objects.filter(
            business_date=target_date,
            machine_key__in=_field_machine_keys(machine_number),
        ).select_related("confirmed_by")
        serialized = InjectionDowntimeConfirmationSerializer(
            confirmations,
            many=True,
        ).data
        for row in serialized:
            row["confirmed_by_name"] = None
        latest_updated_at = confirmations.order_by("-updated_at").values_list(
            "updated_at",
            flat=True,
        ).first()
        return Response(
            {
                "business_date": target_date.isoformat(),
                "latest_updated_at": (
                    latest_updated_at.isoformat() if latest_updated_at else None
                ),
                "confirmations": serialized,
            }
        )

    def post(self, request, *args, **kwargs):
        payload = request.data.copy()
        action = payload.pop("action", "confirm")
        if action == "confirm_transition_start":
            try:
                return self._confirm_transition_start(payload)
            except FieldKanbanError as exc:
                return _error_response(exc)
        if action != "confirm":
            return Response(
                {"detail": "Unsupported action."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            machine_number = _machine_number(payload.get("machine_key"))
        except FieldKanbanError as exc:
            return _error_response(exc)

        event_key = str(payload.get("event_key") or "").strip()
        if not event_key:
            return Response(
                {"detail": "event_key is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        existing = InjectionDowntimeConfirmation.objects.filter(
            event_key=event_key,
        ).first()
        if existing and existing.machine_key not in _field_machine_keys(machine_number):
            return Response(
                {"detail": "The event belongs to another machine."},
                status=status.HTTP_409_CONFLICT,
            )

        serializer = InjectionDowntimeConfirmationSerializer(existing, data=payload)
        serializer.is_valid(raise_exception=True)
        confirmation = serializer.save(
            confirmed_by=None,
            confirmed_at=timezone.now(),
        )
        response_data = InjectionDowntimeConfirmationSerializer(confirmation).data
        response_data["confirmed_by_name"] = None
        return Response(
            response_data,
            status=(
                status.HTTP_200_OK if existing else status.HTTP_201_CREATED
            ),
        )

    def _confirm_transition_start(self, payload):
        """Record a corrected MES-inferred start without gating automatic display."""
        target_date = _target_date(payload.get("business_date"))
        machine_number = _machine_number(payload.get("machine_number"))
        try:
            from_plan_id = int(payload.get("from_plan_id"))
            to_plan_id = int(payload.get("to_plan_id"))
        except (TypeError, ValueError) as exc:
            raise FieldKanbanError("Both plan IDs are required.", code="invalid_transition_plans") from exc
        if from_plan_id <= 0 or to_plan_id <= 0 or from_plan_id == to_plan_id:
            raise FieldKanbanError("Invalid transition plans.", code="invalid_transition_plans")

        start_at = parse_datetime(str(payload.get("start_at") or ""))
        if start_at is None or timezone.is_naive(start_at):
            raise FieldKanbanError("A timezone-aware start time is required.", code="invalid_transition_start")
        start_at = start_at.astimezone(SHANGHAI_TZ)

        machine_row = next(
            (row for row in get_injection_summary(target_date, machine_numbers=[machine_number]).get("machine_rows", [])
             if int(row.get("machine_number") or 0) == machine_number),
            None,
        )
        transition = machine_row.get("transition") if isinstance(machine_row, dict) else None
        if (
            not isinstance(transition, dict)
            or transition.get("phase") not in {"changeover", "new_running"}
            or transition.get("from_plan_id") != from_plan_id
            or transition.get("to_plan_id") != to_plan_id
        ):
            raise FieldKanbanError("The inferred transition has changed. Refresh and review it again.", code="transition_changed", status_code=409)

        stopped_at = parse_datetime(str(transition.get("stopped_at") or ""))
        latest_mes_time = machine_row.get("latest_capacity_time")
        business_start, business_end = business_range(target_date)
        if (
            stopped_at is None or timezone.is_naive(stopped_at)
            or latest_mes_time is None
            or not business_start <= start_at < business_end
            or not stopped_at < start_at <= latest_mes_time
        ):
            raise FieldKanbanError("Start time must be within the observed changeover and production day.", code="invalid_transition_start")

        parts_by_id = {
            int(part["plan_id"]): part
            for part in machine_row.get("parts", [])
            if part.get("plan_id") is not None
        }
        from_part = parts_by_id.get(from_plan_id)
        to_part = parts_by_id.get(to_plan_id)
        if not from_part or not to_part:
            raise FieldKanbanError("Transition plans no longer match this machine.", code="transition_changed", status_code=409)
        from_part_no = str(from_part.get("part_no") or "").strip().upper()
        to_part_no = str(to_part.get("part_no") or "").strip().upper()
        is_core_change = (
            len(from_part_no) >= 10
            and len(from_part_no) == len(to_part_no)
            and from_part_no[:-2] == to_part_no[:-2]
            and from_part_no[-2:] != to_part_no[-2:]
        )
        change_type = "core_change" if is_core_change else "mold_change"

        with transaction.atomic():
            confirmations = list(InjectionDowntimeConfirmation.objects.select_for_update().filter(
                business_date=target_date,
                machine_key__in=_field_machine_keys(machine_number),
                resolution="confirmed",
                reason_code__in=("mold_change", "core_change"),
            ).order_by("-confirmed_at", "-id"))
            confirmation = next((record for record in confirmations if (
                abs((record.detected_start - stopped_at).total_seconds()) <= timedelta(minutes=10).total_seconds()
                and str((record.evidence or {}).get("from_part_no") or from_part_no).strip().upper() == from_part_no
                and str((record.evidence or {}).get("to_part_no") or to_part_no).strip().upper() == to_part_no
            )), None)
            synthetic = confirmation is None
            if confirmation is None:
                confirmation, _created = InjectionDowntimeConfirmation.objects.select_for_update().get_or_create(
                    event_key=f"{target_date.isoformat()}:{machine_number}:{from_plan_id}:{to_plan_id}:transition",
                    defaults={
                        "business_date": target_date,
                        "machine_key": str(machine_number),
                        "machine_label": str(machine_row.get("machine") or machine_row.get("machine_name") or f"{machine_number}호기"),
                        "detected_type": change_type,
                        "detected_start": stopped_at,
                        "detected_end": start_at,
                        "duration_minutes": max(0, round((start_at - stopped_at).total_seconds() / 60)),
                        "resolution": "confirmed",
                        "reason_code": change_type,
                        "evidence": {},
                    },
                )
                # A pre-existing row with the deterministic event key must not
                # supply the start or resolution used by the allocator.
                confirmation.business_date = target_date
                confirmation.machine_key = str(machine_number)
                confirmation.machine_label = str(machine_row.get("machine") or machine_row.get("machine_name") or f"{machine_number}호기")
                confirmation.detected_type = change_type
                confirmation.detected_start = stopped_at
                confirmation.detected_end = start_at
                confirmation.duration_minutes = max(0, round((start_at - stopped_at).total_seconds() / 60))
                confirmation.resolution = "confirmed"
                confirmation.reason_code = change_type
            confirmation.evidence = {
                **(confirmation.evidence if isinstance(confirmation.evidence, dict) else {}),
                "from_plan_id": from_plan_id,
                "to_plan_id": to_plan_id,
                "from_part_no": from_part_no,
                "to_part_no": to_part_no,
                "transition_stopped_at": stopped_at.isoformat(),
                "transition_start_at": start_at.isoformat(),
                "transition_start_source": "field_confirmation",
            }
            confirmation.confirmed_at = timezone.now()
            confirmation.confirmed_by = None
            confirmation.save(update_fields=(
                ["business_date", "machine_key", "machine_label", "detected_type", "detected_start",
                 "detected_end", "duration_minutes", "resolution", "reason_code"]
                if synthetic else []
            ) + ["evidence", "confirmed_at", "confirmed_by", "updated_at"])

        cache.delete(f"field-kanban:production:v3:{target_date.isoformat()}")
        response_data = InjectionDowntimeConfirmationSerializer(confirmation).data
        response_data["confirmed_by_name"] = None
        return Response(response_data)


class FieldMaterialsView(APIView):
    permission_classes = [IsAuthenticated, DevelopmentPermission, FieldWriteProfileRequired]
    parser_classes = [MultiPartParser, FormParser]

    def get(self, request, *args, **kwargs):
        try:
            return Response(
                build_field_material_readiness(
                    _target_date(request.query_params.get("date")),
                    include_status=_query_bool(
                        request.query_params.get("include_status"),
                        default=False,
                    ),
                )
            )
        except FieldKanbanError as exc:
            return _error_response(exc)

    def post(self, request, *args, **kwargs):
        try:
            conversion_notification_url = request.build_absolute_uri(
                reverse("production-field-material-conversion-webhook")
            )
            document = save_field_material(
                kind=request.data.get("kind"),
                part_no=request.data.get("part_no"),
                model_name=request.data.get("model_name"),
                revision=request.data.get("revision"),
                source_file=request.FILES.get("file"),
                preview_pdf=request.FILES.get("preview_pdf"),
                user=request.user,
                match_rule=request.data.get("match_rule"),
                conversion_notification_url=conversion_notification_url,
            )
            return Response({"document": document}, status=status.HTTP_201_CREATED)
        except FieldKanbanError as exc:
            return _error_response(exc)


class FieldMaterialPreviewRepairView(APIView):
    """Repair a legacy raw PDF or restart an existing Office conversion."""

    permission_classes = [IsAuthenticated, DevelopmentPermission, FieldWriteProfileRequired]
    parser_classes = [JSONParser]

    def post(self, request, document_id, *args, **kwargs):
        try:
            conversion_notification_url = request.build_absolute_uri(
                reverse("production-field-material-conversion-webhook")
            )
            document = repair_field_material_preview(
                document_id,
                conversion_notification_url=conversion_notification_url,
            )
            return Response({"document": document})
        except FieldKanbanError as exc:
            return _error_response(exc)


class FieldMaterialShareView(APIView):
    """Share a ready document across plans with the same Part No. prefix."""

    permission_classes = [IsAuthenticated, DevelopmentPermission, FieldWriteProfileRequired]
    parser_classes = [JSONParser]

    def post(self, request, document_id, *args, **kwargs):
        try:
            document = share_existing_field_material(document_id, user=request.user)
            return Response({"document": document}, status=status.HTTP_201_CREATED)
        except FieldKanbanError as exc:
            return _error_response(exc)


class FieldMaterialConversionWebhookView(APIView):
    """Accept only signed Cloudinary callbacks for Office preview conversion."""

    authentication_classes = []
    permission_classes = [AllowAny]
    parser_classes = [JSONParser]

    def post(self, request, *args, **kwargs):
        try:
            raw_body = request.body.decode("utf-8")
            timestamp = int(request.headers.get("X-Cld-Timestamp") or 0)
            signature = str(request.headers.get("X-Cld-Signature") or "")
            if not timestamp or not signature or not cloudinary.utils.verify_notification_signature(
                raw_body,
                timestamp,
                signature,
            ):
                return Response(
                    {"detail": "Invalid Cloudinary notification signature."},
                    status=status.HTTP_403_FORBIDDEN,
                )
            payload = json.loads(raw_body)
            if payload.get("notification_type") != "info" or payload.get("info_kind") != "aspose":
                return Response({"accepted": False, "ignored": True}, status=status.HTTP_202_ACCEPTED)
            document = apply_field_material_conversion_notification(
                public_id=payload.get("public_id"),
                info_status=payload.get("info_status"),
                error=payload.get("error") or payload.get("message") or "",
                repair_token=request.query_params.get("repair_token"),
            )
            return Response({"accepted": True, "document": document})
        except (TypeError, ValueError, json.JSONDecodeError):
            return Response(
                {"detail": "Invalid Cloudinary notification payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FieldKanbanError as exc:
            return _error_response(exc)
