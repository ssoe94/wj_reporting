"""Device writes. A station lock orders writes with credential rotation and suspension."""

import hashlib
import hmac
import json
import re
from datetime import timedelta
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.response import Response

from injection.cycle_time_history import business_date_at
from .base import FieldAPIView
from .contract import (
    CONTRACT, ContractError, read_device_json, validate_envelope, validate_heartbeat,
    validate_ingest,
)
from .issuer_rules import reservation_fields
from .models import FieldArchiveEvent, FieldCredential, FieldEvent, FieldIngestBatch, FieldStation, FieldStationHeartbeat


_TOKEN = re.compile(r'([0-9a-f]{32})\.([A-Za-z0-9_-]{43})', re.ASCII)
_DUPLICATE_WINDOW = timedelta(minutes=10)


def secret_digest(secret):
    return hashlib.sha256(secret.encode('ascii')).hexdigest()


def _device_identity(request):
    scheme, _, value = request.headers.get('Authorization', '').partition(' ')
    match = _TOKEN.fullmatch(value) if scheme.lower() == 'wjfield' else None
    if not match:
        raise ContractError('invalid_token', 401)
    key_id, secret = match.groups()
    credential = FieldCredential.objects.select_related('station').filter(key_id=key_id).first()
    expected = credential.secret_hash if credential is not None else '0' * 64
    if not hmac.compare_digest(secret_digest(secret), expected) or credential is None or credential.revoked_at:
        raise ContractError('invalid_token', 401)
    if not credential.station.enabled:
        raise ContractError('station_denied', 403)
    return credential


def _lock_station(credential):
    station = FieldStation.objects.select_for_update().get(pk=credential.station_id)
    if not FieldCredential.objects.filter(pk=credential.pk, revoked_at__isnull=True).exists():
        raise ContractError('invalid_token', 401)
    if not station.enabled:
        raise ContractError('station_denied', 403)
    return station


def _canonical_event(event):
    # Type-sensitive, including bool vs int in preserved extension fields.
    return json.dumps(event, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def _ingest(station, database_id, batch_id, raw_hash, events, timestamps, received_at, *, archive=False):
    existing_batch = FieldIngestBatch.objects.filter(station=station, batch_id=batch_id).first()
    if existing_batch is not None:
        if existing_batch.request_sha256 != raw_hash:
            raise ContractError('batch_conflict', 409)
        return existing_batch.ack

    event_model = FieldArchiveEvent if archive else FieldEvent
    existing = dict(event_model.objects.filter(
        station=station, database_id=database_id, seq__in=[event['seq'] for event in events],
    ).values_list('seq', 'payload'))
    offset = None if archive else FieldStationHeartbeat.objects.filter(
        station=station, received_at__lte=received_at,
    ).values_list('clock_offset_seconds', flat=True).first()
    offset_limit = getattr(settings, 'FIELD_MONITORING_CLOCK_HOLD_SECONDS', 3600)
    offset_suspect = offset is not None and abs(offset) > offset_limit
    pending = []
    for index, (event, occurred_at) in enumerate(zip(events, timestamps, strict=True)):
        seq = event['seq']
        if seq in existing:
            if _canonical_event(existing[seq]) != _canonical_event(event):
                raise ContractError('event_conflict', 409, event_index=index)
            continue
        issuer_fields = {}
        if not archive:
            issuer_namespace, label_print_date = reservation_fields(event)
            issuer_fields = {'issuer_namespace': issuer_namespace, 'label_print_date': label_print_date}
        pending.append(event_model(
            station=station, database_id=database_id, seq=seq,
            app=event['app'], event_type=event['type'], mode=event['mode'], result=event['result'],
            reason=event['reason'], barcode=event.get('barcode') or '', serial=event.get('serial') or '',
            part_no=event.get('part_no') or '', job_id=event.get('ref', {}).get('job_id', ''),
            occurred_at=occurred_at, received_at=received_at, business_date=business_date_at(occurred_at),
            clock_offset_seconds=offset,
            clock_suspect=offset_suspect or occurred_at > received_at + timedelta(minutes=5),
            payload=event, **issuer_fields,
        ))

    event_model.objects.bulk_create(pending)
    ack = {
        'contract': CONTRACT, 'station_id': station.station_id, 'database_id': str(database_id),
        'batch_id': str(batch_id), 'accepted': len(pending),
        'duplicates': len(events) - len(pending), 'max_seq': events[-1]['seq'],
    }
    FieldIngestBatch.objects.create(
        station=station, batch_id=batch_id, request_sha256=raw_hash, ack=ack, received_at=received_at,
    )
    return ack


def _heartbeat(station, database_id, heartbeat_id, payload, client_at, received_at):
    record = FieldStationHeartbeat.objects.filter(station=station).first()
    current = record is None or record.received_at <= received_at
    if current:
        if record is None:
            record = FieldStationHeartbeat(station=station)
        elif record.payload['session_id'] != payload['session_id']:
            session = UUID(payload['session_id'])
            if (record.previous_session_id == session
                    and record.previous_session_received_at >= received_at - _DUPLICATE_WINDOW):
                record.duplicate_sender_until = received_at + _DUPLICATE_WINDOW
            record.previous_session_id = UUID(record.payload['session_id'])
            record.previous_session_received_at = record.received_at
        record.received_at = received_at
        record.clock_offset_seconds = round((client_at - received_at).total_seconds())
        record.payload = payload
        record.save()
    return {
        'contract': CONTRACT, 'station_id': station.station_id, 'database_id': str(database_id),
        'heartbeat_id': str(heartbeat_id), 'received_at': received_at, 'current': current,
    }


class DeviceView(FieldAPIView):
    authentication_classes = ()
    permission_classes = ()
    parser_classes = ()

    def post(self, request):
        received_at = timezone.now()
        try:
            credential = _device_identity(request)
            raw, payload = read_device_json(request)
            database_id = validate_envelope(payload)
            if payload['station_id'] != credential.station.station_id:
                raise ContractError('station_denied', 403)
            prepared = self.prepare(raw, payload)
            return Response(self.save(credential, database_id, payload, prepared, received_at))
        except ContractError as exc:
            body = {'code': exc.code}
            if exc.event_index is not None:
                body['event_index'] = exc.event_index
            headers = {'WWW-Authenticate': 'WJField'} if exc.status == 401 else None
            return Response(body, status=exc.status, headers=headers)

    def save(self, credential, database_id, payload, prepared, received_at):
        def persist():
            with transaction.atomic():
                station = _lock_station(credential)
                return self.persist(station, database_id, payload, prepared, received_at)

        try:
            return persist()
        except IntegrityError:
            # Re-evaluate after rollback in case a competing insert won the unique key.
            return persist()


class IngestView(DeviceView):
    def prepare(self, raw, payload):
        batch_id, timestamps = validate_ingest(payload)
        if 'archive_capability' in payload or any('archive_source' in event for event in payload['events']):
            raise ContractError('invalid_payload')
        return batch_id, timestamps, hashlib.sha256(raw).hexdigest()

    def persist(self, station, database_id, payload, prepared, received_at):
        batch_id, timestamps, raw_hash = prepared
        return _ingest(station, database_id, batch_id, raw_hash, payload['events'], timestamps, received_at)


class ArchiveIngestView(DeviceView):
    sources = {
        'barcode_scan': ('barcode', {'scan.recorded'}),
        'barcode_reset': ('barcode', {'operator.action'}),
        'weigh_scan': ('weigh_label', {'label.reread'}),
        'weigh_print': ('weigh_label', {
            'weigh.result', 'label.reserved', 'label.dispatched', 'queue.partial_flush', 'operator.action',
        }),
    }

    def prepare(self, raw, payload):
        if UUID(payload['database_id']).version != 5:
            raise ContractError('invalid_payload')
        if set(payload) == {'contract', 'station_id', 'database_id', 'archive_capability'}:
            if payload['archive_capability'] is not True:
                raise ContractError('invalid_payload')
            return None
        if set(payload) != {'contract', 'station_id', 'database_id', 'batch_id', 'events'}:
            raise ContractError('invalid_payload')
        batch_id, timestamps = validate_ingest(payload)
        seen_sources = set()
        for index, event in enumerate(payload['events']):
            source = event.get('archive_source')
            app, types = self.sources.get(source, (None, ())) if isinstance(source, str) else (None, ())
            if (event['app'] != app or event['type'] not in types or event['mode'] != 'unknown'
                    or not event.get('ref', {}).get('source_key')
                    or event.get('evidence') or 'issuer_assignment_id' in event.get('detail', {})):
                raise ContractError('invalid_payload', event_index=index)
            seen_sources.add(source)
        if len(seen_sources) != 1:
            raise ContractError('invalid_payload')
        return batch_id, timestamps, hashlib.sha256(raw).hexdigest()

    def persist(self, station, database_id, payload, prepared, received_at):
        if prepared is None:
            return {'contract': CONTRACT, 'station_id': station.station_id, 'database_id': str(database_id),
                    'archive_capability': 1}
        if any(event['app'] not in station.apps for event in payload['events']):
            raise ContractError('station_denied', 403)
        batch_id, timestamps, digest = prepared
        return _ingest(station, database_id, batch_id, digest, payload['events'], timestamps, received_at, archive=True)


class HeartbeatView(DeviceView):
    def prepare(self, raw, payload):
        return validate_heartbeat(payload)

    def persist(self, station, database_id, payload, prepared, received_at):
        heartbeat_id, client_at = prepared
        return _heartbeat(station, database_id, heartbeat_id, payload, client_at, received_at)
