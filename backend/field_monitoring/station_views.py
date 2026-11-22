from secrets import token_urlsafe
from uuid import uuid4

from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response

from config.authentication import ScopedJWTAuthentication
from .base import FieldAPIView
from .contract import APP_TYPES, STATION_ID_PATTERN
from .device_views import secret_digest
from .models import MAX_INJECTION_MACHINE, MIN_INJECTION_MACHINE, FieldCredential, FieldStation, FieldStationChange
from .permissions import CanManageFieldStations


class StationInput(serializers.Serializer):
    display_name = serializers.CharField(max_length=120)
    apps = serializers.ListField(child=serializers.ChoiceField(choices=sorted(APP_TYPES)),
                                 allow_empty=False, max_length=len(APP_TYPES))
    location = serializers.CharField(max_length=120, required=False, allow_blank=True)
    line_note = serializers.CharField(max_length=160, required=False, allow_blank=True)
    enabled = serializers.BooleanField(required=False)
    injection_machine_number = serializers.IntegerField(
        min_value=MIN_INJECTION_MACHINE, max_value=MAX_INJECTION_MACHINE, required=False, allow_null=True,
    )

    def validate_apps(self, apps):
        if len(set(apps)) != len(apps):
            raise serializers.ValidationError('Apps must be unique.')
        return apps

    def to_internal_value(self, data):
        if not isinstance(data, dict) or data.keys() - self.fields.keys():
            raise serializers.ValidationError('Unexpected station fields.')
        return super().to_internal_value(data)


class StationCreateInput(StationInput):
    station_id = serializers.RegexField(regex=STATION_ID_PATTERN.pattern + r'\Z', max_length=64)


def _audit(station, actor, action, changes=None):
    FieldStationChange.objects.create(station=station, actor=actor, action=action, changes=changes or {})


def _station_json(station, active):
    return {
        'station_id': station.station_id, 'display_name': station.display_name, 'apps': station.apps,
        'location': station.location, 'line_note': station.line_note, 'enabled': station.enabled,
        'injection_machine_number': station.injection_machine_number,
        'created_at': station.created_at, 'updated_at': station.updated_at, 'credential_active': active,
    }


def _active_credentials(station):
    return FieldCredential.objects.filter(station_id=station.pk, revoked_at__isnull=True)


class ManageView(FieldAPIView):
    authentication_classes = (ScopedJWTAuthentication,)
    permission_classes = (CanManageFieldStations,)


class StationsView(ManageView):
    def get(self, request):
        active = FieldCredential.objects.filter(station_id=OuterRef('pk'), revoked_at__isnull=True)
        stations = FieldStation.objects.annotate(has_credential=Exists(active)).order_by('station_id')
        return Response({'stations': [_station_json(station, station.has_credential) for station in stations]})

    def post(self, request):
        form = StationCreateInput(data=request.data)
        form.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                station = FieldStation.objects.create(created_by=request.user, **form.validated_data)
                _audit(station, request.user, 'registered', form.validated_data)
        except IntegrityError:
            if FieldStation.objects.filter(station_id=form.validated_data['station_id']).exists():
                return Response({'code': 'station_id_conflict'}, status=409)
            raise
        return Response(_station_json(station, False), status=201)


class StationView(ManageView):
    @transaction.atomic
    def patch(self, request, station_id):
        station = get_object_or_404(FieldStation.objects.select_for_update(), station_id=station_id)
        form = StationInput(data=request.data, partial=True)
        form.is_valid(raise_exception=True)
        changes = {}
        for name, next_value in form.validated_data.items():
            previous = getattr(station, name)
            if previous != next_value:
                changes[name] = {'before': previous, 'after': next_value}
                setattr(station, name, next_value)
        if changes:
            station.save(update_fields=[*changes, 'updated_at'])
            _audit(station, request.user, 'updated', changes)
        return Response(_station_json(station, _active_credentials(station).exists()))


class IssueTokenView(ManageView):
    @transaction.atomic
    def post(self, request, station_id):
        station = get_object_or_404(FieldStation.objects.select_for_update(), station_id=station_id)
        if not station.enabled:
            return Response({'code': 'station_denied'}, status=403)
        rotated = _active_credentials(station).update(revoked_at=timezone.now(), revoked_by=request.user)
        key_id = uuid4().hex
        secret = token_urlsafe(32)
        FieldCredential.objects.create(
            station=station, key_id=key_id, secret_hash=secret_digest(secret), issued_by=request.user,
        )
        _audit(station, request.user, 'token_rotated' if rotated else 'token_issued')
        return Response({'station_id': station.station_id, 'token': f'{key_id}.{secret}'},
                        headers={'Cache-Control': 'no-store'})


class RevokeTokenView(ManageView):
    @transaction.atomic
    def post(self, request, station_id):
        station = get_object_or_404(FieldStation.objects.select_for_update(), station_id=station_id)
        if _active_credentials(station).update(revoked_at=timezone.now(), revoked_by=request.user):
            _audit(station, request.user, 'token_revoked')
        return Response(status=204)
