"""The registry records ownership; the station imports its policy explicitly."""

from collections import defaultdict
from datetime import date, timedelta, timezone as fixed_timezone
from uuid import UUID

from django.db import IntegrityError, connection, transaction
from django.db.models import Max
from django.db.models.functions import Collate
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response

from .contract import STATION_ID_PATTERN
from .issuer_rules import MAX_CEILINGS, MAX_GRANTS, MAX_SERIAL, NAMESPACE, PART, grant_summaries, label_date_code, policy_bytes, policy_digest, serial_number
from .models import FieldEvent, FieldIssuerRetainedFloor, FieldLabelIssuer, FieldStation, FieldStationHeartbeat
from .station_views import ManageView

SHANGHAI = fixed_timezone(timedelta(hours=8))


class StrictInput(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict) or data.keys() - self.fields.keys():
            raise serializers.ValidationError('Unexpected issuer fields.')
        return super().to_internal_value(data)


class AssignmentInput(StrictInput):
    namespace = serializers.RegexField(regex=NAMESPACE.pattern + r'\Z', max_length=3)
    part_no = serializers.RegexField(regex=PART.pattern + r'\Z', max_length=32)
    station_id = serializers.RegexField(regex=STATION_ID_PATTERN.pattern + r'\Z', max_length=64, allow_null=True)
    program = serializers.CharField(max_length=80)
    pc_note = serializers.CharField(max_length=120, required=False, allow_blank=True, default='')
    reason = serializers.CharField(max_length=240)

    def validate(self, data):
        if data['station_id'] is not None:
            if data['program'] != 'weigh_label' or data['pc_note']:
                raise serializers.ValidationError('An agent issuer must be the station weigh app.')
        elif not data['pc_note'] or data['program'] == 'weigh_label':
            raise serializers.ValidationError('Enter the external program and PC reference.')
        return data


class ReasonInput(StrictInput):
    reason = serializers.CharField(max_length=240)


class CeilingInput(StrictInput):
    print_date = serializers.DateField(input_formats=['%Y-%m-%d'])
    serial_floor = serializers.IntegerField(min_value=0, max_value=MAX_SERIAL)

    def to_internal_value(self, data):
        if not isinstance(data, dict) or type(data.get('serial_floor')) is not int:
            raise serializers.ValidationError('Enter an integer serial ceiling.')
        return super().to_internal_value(data)


class ReleaseInput(ReasonInput):
    ceilings = CeilingInput(many=True, allow_empty=False, max_length=MAX_CEILINGS)


def _json(row):
    return {
        'id': row.pk, 'namespace': row.namespace, 'part_no': row.part_no,
        'station_id': row.station.station_id if row.station_id else None,
        'program': row.program, 'pc_note': row.pc_note,
        'assigned_at': row.assigned_at, 'stopped_at': row.stopped_at, 'released_at': row.released_at,
        'reason': row.reason, 'stop_reason': row.stop_reason, 'release_reason': row.release_reason,
        'ceilings': row.ceilings,
        'assigned_by': row.assigned_by_id, 'stopped_by': row.stopped_by_id, 'released_by': row.released_by_id,
    }


def _lock_key(namespace, part_no):
    # Use the same lock for assign, stop and release, including the first
    # assignment when there is no row yet. The partial index is still final.
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                           [f'field-label-issuer/{namespace}/{part_no}'])


def _bump(station):
    station.issuer_policy_revision += 1
    station.save(update_fields=['issuer_policy_revision'])
    return station.issuer_policy_revision


def active_issuers():
    return FieldLabelIssuer.objects.filter(released_at__isnull=True, stopped_at__isnull=True)


def policy_for(station, rows):
    grants = []
    for row in rows:
        transfer = None
        if row.predecessor_id:
            transfer = {'previous_id': row.predecessor_id, 'ceilings': row.predecessor.ceilings}
        grants.append({'namespace': row.namespace, 'part_no': row.part_no,
                       'assignment_id': row.pk, 'transfer': transfer})
    return {'station_id': station.station_id, 'revision': station.issuer_policy_revision,
            'grants': sorted(grants, key=lambda row: (row['namespace'], row['part_no']))}


def station_policies(stations):
    by_station = defaultdict(list)
    for row in active_issuers().filter(station_id__in=[s.pk for s in stations]).select_related('predecessor'):
        by_station[row.station_id].append(row)
    return {station.pk: policy_for(station, by_station[station.pk]) for station in stations}


def reported_policy_matches(policy, heartbeat):
    actual = heartbeat.payload.get('issuer_policy') if heartbeat else None
    if actual is None:
        return policy['revision'] == 0 and not policy['grants']
    return (isinstance(actual, dict) and actual.get('revision') == policy['revision']
            and actual.get('sha256') == policy_digest(policy) and actual.get('grants') == grant_summaries(policy))


class IssuerAssignmentsView(ManageView):
    def get(self, request):
        rows = FieldLabelIssuer.objects.select_related('station').order_by('namespace', 'part_no', '-assigned_at', '-pk')
        return Response({'assignments': [_json(row) for row in rows]})

    def post(self, request):
        form = AssignmentInput(data=request.data)
        form.is_valid(raise_exception=True)
        fields = dict(form.validated_data)
        station_name = fields.pop('station_id')
        key = {name: fields[name] for name in ('namespace', 'part_no')}
        try:
            with transaction.atomic():
                _lock_key(**key)
                history = FieldLabelIssuer.objects.filter(**key)
                if history.filter(released_at__isnull=True).exists():
                    return Response({'code': 'issuer_conflict'}, status=409)
                station = None
                if station_name is not None:
                    station = FieldStation.objects.select_for_update().filter(station_id=station_name).first()
                    if station is None or not station.enabled or 'weigh_label' not in station.apps:
                        return Response({'code': 'issuer_station_required'}, status=400)
                    if active_issuers().filter(station=station).count() >= MAX_GRANTS:
                        return Response({'code': 'issuer_policy_limit'}, status=409)
                previous = history.order_by('-released_at', '-pk').first()
                row = FieldLabelIssuer.objects.create(station=station, predecessor=previous,
                                                      assigned_at=timezone.now(), assigned_by=request.user, **fields)
                if station:
                    if len(policy_bytes(station_policies([station])[station.pk])) > 2 * 1024 * 1024:
                        transaction.set_rollback(True)
                        return Response({'code': 'issuer_policy_limit'}, status=409)
                    _bump(station)
        except IntegrityError:
            if FieldLabelIssuer.objects.filter(**key, released_at__isnull=True).exists():
                return Response({'code': 'issuer_conflict'}, status=409)
            raise
        return Response(_json(row), status=201)


def _lock_assignment(assignment_id):
    observed = get_object_or_404(FieldLabelIssuer.objects.only('namespace', 'part_no'), pk=assignment_id)
    _lock_key(observed.namespace, observed.part_no)
    row = FieldLabelIssuer.objects.select_for_update().get(pk=assignment_id)
    if row.station_id:
        row.station = FieldStation.objects.select_for_update().get(pk=row.station_id)
    return row


class IssuerStopView(ManageView):
    @transaction.atomic
    def post(self, request, assignment_id):
        form = ReasonInput(data=request.data)
        form.is_valid(raise_exception=True)
        row = _lock_assignment(assignment_id)
        if row.stopped_at is not None or row.released_at is not None:
            return Response({'code': 'issuer_conflict'}, status=409)
        row.stopped_at = timezone.now()
        row.stopped_by = request.user
        row.stop_reason = form.validated_data['reason']
        if row.station_id:
            row.withdrawal_revision = _bump(row.station)
        row.save(update_fields=['stopped_at', 'stopped_by', 'stop_reason', 'withdrawal_revision'])
        return Response(_json(row))


def _station_release_proof(row, moment):
    station = row.station
    heartbeat = FieldStationHeartbeat.objects.filter(station=station).first()
    policy = station_policies([station])[station.pk]
    if (heartbeat is None or heartbeat.received_at < row.stopped_at
            or moment - heartbeat.received_at > timedelta(minutes=3)
            or abs(heartbeat.clock_offset_seconds) > 300
            or (heartbeat.duplicate_sender_until and heartbeat.duplicate_sender_until > moment)
            or not reported_policy_matches(policy, heartbeat)):
        return None, 'issuer_heartbeat_required'
    actual = heartbeat.payload['issuer_policy']
    if type(actual.get('applied_seq')) is not int:
        return None, 'issuer_heartbeat_required'
    if (heartbeat.payload['outbox'].get('pending_count') != 0
            or heartbeat.payload['outbox'].get('state') != 'ready'):
        return None, 'issuer_work_pending'
    database_id = UUID(heartbeat.payload['database_id'])
    applied = FieldEvent.objects.filter(
        station=station, database_id=database_id, seq=actual['applied_seq'],
        app='weigh_label', event_type='operator.action', reason='issuer_policy_applied',
        received_at__gte=row.stopped_at, payload__detail__revision=actual['revision'],
        payload__detail__sha256=actual['sha256'],
    ).exists()
    if not applied:
        return None, 'issuer_heartbeat_required'
    return {'database_id': str(database_id), 'seq': actual['applied_seq'], 'sha256': actual['sha256']}, None


def _compact_floors(floors):
    by_code = {}
    for day, floor in sorted(floors.items()):
        code = label_date_code(date.fromisoformat(day))
        if code not in by_code or by_code[code][1] <= floor:
            by_code[code] = (day, floor)
    return dict(by_code.values())


def _verified_ceilings(row):
    floors = {item['print_date']: item['serial_floor'] for item in row.predecessor.ceilings} if row.predecessor_id else {}
    if row.station_id:
        # Older v1 native reservations may lack assignment id. Their exact
        # parsed barcode and station still establish a lower bound.
        events = FieldEvent.objects.filter(station_id=row.station_id, app='weigh_label', event_type='label.reserved',
                                           issuer_namespace=row.namespace, part_no=row.part_no,
                                           label_print_date__isnull=False)
        collation = 'C' if connection.vendor == 'postgresql' else 'BINARY'
        for item in events.values('label_print_date').annotate(serial=Max(Collate('serial', collation))):
            day, number = item['label_print_date'].isoformat(), serial_number(item['serial'])
            if number is not None:
                floors[day] = max(number, floors.get(day, 0))
        # Read the compacted floors after the live scan. An overlapping prune
        # commits the floor update and the event deletion together.
        retained = FieldIssuerRetainedFloor.objects.filter(
            station_id=row.station_id, namespace=row.namespace, part_no=row.part_no,
        ).values_list('print_date', 'serial_floor')
        for print_date, number in retained:
            day = print_date.isoformat()
            floors[day] = max(number, floors.get(day, 0))
    return floors


class IssuerReleaseView(ManageView):
    @transaction.atomic
    def post(self, request, assignment_id):
        form = ReleaseInput(data=request.data)
        form.is_valid(raise_exception=True)
        row = _lock_assignment(assignment_id)
        if row.released_at is not None:
            return Response({'code': 'issuer_conflict'}, status=409)
        if row.stopped_at is None:
            return Response({'code': 'issuer_stop_required'}, status=409)
        now = timezone.now()
        proof = {}
        if row.station_id:
            proof, blocked = _station_release_proof(row, now)
            if blocked:
                return Response({'code': blocked}, status=409)
        today = now.astimezone(SHANGHAI).date().isoformat()
        evidence = form.validated_data['ceilings']
        submitted = {item['print_date'].isoformat(): item['serial_floor'] for item in evidence}
        required = _compact_floors(_verified_ceilings(row))
        by_code = {label_date_code(date.fromisoformat(day)): floor for day, floor
                   in _compact_floors(submitted).items()}
        if (len(submitted) != len(evidence) or today not in submitted or any(day > today for day in submitted)
                or any(by_code.get(label_date_code(date.fromisoformat(day)), -1) < floor
                       for day, floor in required.items())):
            minimums = dict(required)
            minimums.setdefault(today, 0)
            return Response({'code': 'issuer_ceiling_required', 'minimums': [
                {'print_date': day, 'serial_floor': floor} for day, floor in sorted(minimums.items())
            ]}, status=409)
        compact = _compact_floors(submitted)
        compact[today] = submitted[today]
        row.ceilings = [{'print_date': day, 'serial_floor': floor} for day, floor in sorted(compact.items())]
        row.release_proof = proof
        row.released_at = now
        row.released_by = request.user
        row.release_reason = form.validated_data['reason']
        row.save(update_fields=['ceilings', 'release_proof', 'released_at', 'released_by', 'release_reason'])
        return Response(_json(row))


class IssuerPolicyView(ManageView):
    @transaction.atomic
    def get(self, request, station_id):
        station = get_object_or_404(FieldStation.objects.select_for_update(), station_id=station_id)
        return Response(station_policies([station])[station.pk], headers={'Cache-Control': 'no-store'})
