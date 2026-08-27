from __future__ import annotations

import json
import re

import cloudinary.utils
from django.urls import reverse
from django.utils.dateparse import parse_date
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, BasePermission, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from injection.permissions import DevelopmentPermission, InjectionPermission, QualityPermission

from .field_kanban import (
    FieldKanbanError,
    apply_field_material_conversion_notification,
    build_field_kanban_snapshot,
    build_field_material_readiness,
    current_shanghai_business_date,
    save_defect_checkpoint,
    save_field_material,
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
    permission_classes = [IsAuthenticated, InjectionPermission]

    def get(self, request, *args, **kwargs):
        try:
            target_date = _target_date(request.query_params.get("date"))
            machine_number = _machine_number(request.query_params.get("machine_number"))
            _enforce_terminal_machine_scope(request, machine_number)
            include_quality = (
                _query_bool(request.query_params.get("include_quality"))
                and QualityPermission().has_permission(request, self)
            )
            return Response(
                build_field_kanban_snapshot(
                    target_date,
                    machine_number,
                    include_quality=include_quality,
                )
            )
        except FieldKanbanError as exc:
            return _error_response(exc)


class FieldDefectCheckpointView(APIView):
    permission_classes = [IsAuthenticated, InjectionPermission, FieldWriteProfileRequired]

    def post(self, request, *args, **kwargs):
        try:
            target_date = _target_date(request.data.get("business_date"))
            machine_number = _machine_number(request.data.get("machine_number"))
            _enforce_terminal_machine_scope(request, machine_number)
            checkpoint, created = save_defect_checkpoint(
                target_date=target_date,
                machine_number=machine_number,
                event_key=request.data.get("event_key"),
                trigger=request.data.get("trigger"),
                items=request.data.get("items", []),
                plan_id=request.data.get("plan_id"),
                part_no=request.data.get("part_no", ""),
                sequence=request.data.get("sequence"),
                user=request.user,
            )
            return Response(
                {"checkpoint": checkpoint, "created": created},
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )
        except FieldKanbanError as exc:
            return _error_response(exc)


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
            )
            return Response({"accepted": True, "document": document})
        except (TypeError, ValueError, json.JSONDecodeError):
            return Response(
                {"detail": "Invalid Cloudinary notification payload."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FieldKanbanError as exc:
            return _error_response(exc)
