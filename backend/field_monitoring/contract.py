"""Validation for the device protocol. Persist the validated event unchanged."""

import json
import re
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from django.core.exceptions import RequestDataTooBig
from django.http import UnreadablePostError


CONTRACT = 'wj.field.v1'
MAX_BODY = 512 * 1024
MAX_SEQ = 9007199254740991
APP_TYPES = {
    'barcode': {'scan.recorded'},
    'weigh_label': {'weigh.result', 'label.reserved', 'label.dispatched', 'label.reread', 'queue.partial_flush'},
    'vision_backcover': {'vision.cycle'},
    'vision_capture': {'capture.pair', 'capture.single'},
    'vision_uv': {'vision.batch'},
}
WORK_REFERENCES = {
    'weigh.result': 'cycle_id',
    'label.reserved': 'job_id',
    'label.dispatched': 'attempt_id',
    'vision.cycle': 'cycle_id',
    'capture.pair': 'pair_id',
    'vision.batch': 'batch_id',
}
COMMON_TYPES = {
    'app.started', 'app.stopped', 'device.state', 'mode.changed', 'config.applied',
    'operator.action', 'backup.completed', 'backup.failed',
}
MODES = {'production', 'test', 'demo', 'preview', 'manual', 'unknown'}
RESULTS = {'ok', 'ng', 'error', 'info'}
DEVICE_STATES = {'connected', 'disconnected', 'fault', 'unknown'}
APP_STATES = {'running', 'stopped', 'fault', 'unknown'}
OUTBOX_STATES = {'ready', 'backoff', 'blocked', 'storage_pressure'}
STATION_ID_PATTERN = re.compile(r'[A-Za-z0-9_-]{1,64}', re.ASCII)
_CODE_PATTERN = re.compile(r'[a-z][a-z0-9_.-]{0,63}', re.ASCII)
_ISO_TIME = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', re.ASCII)
_DECIMAL = re.compile(r'-?[0-9]+(?:\.[0-9]+)?', re.ASCII)


class ContractError(ValueError):
    def __init__(self, code='invalid_payload', status=400, *, event_index=None):
        self.code = code
        self.status = status
        self.event_index = event_index
        super().__init__(code)


def _check(condition):
    if not condition:
        raise ContractError()


def _invalid_json_value(_):
    raise ContractError()


def _unique_object(pairs):
    result = dict(pairs)
    _check(len(result) == len(pairs))
    return result


def _check_json_tree(value, depth=0, max_depth=16):
    _check(depth <= max_depth)
    if isinstance(value, str):
        _check('\x00' not in value)
        value.encode('utf-8', errors='strict')
    elif type(value) is int:
        _check(-MAX_SEQ <= value <= MAX_SEQ)
    elif isinstance(value, dict):
        for key, item in value.items():
            _check_json_tree(key, depth + 1, max_depth)
            _check_json_tree(item, depth + 1, max_depth)
    elif isinstance(value, list):
        for item in value:
            _check_json_tree(item, depth + 1, max_depth)


def read_device_json(request):
    if request.content_type.split(';', 1)[0].strip().lower() != 'application/json':
        raise ContractError('unsupported_media_type', 415)
    if request.headers.get('Content-Encoding', 'identity').strip().lower() != 'identity':
        raise ContractError('unsupported_media_type', 415)
    try:
        length = int(request.META.get('CONTENT_LENGTH') or '0')
    except ValueError as exc:
        raise ContractError() from exc
    _check(length >= 0)
    if length > MAX_BODY:
        raise ContractError('payload_too_large', 413)
    try:
        stream = request.stream
        raw = stream.read(MAX_BODY + 1) if stream is not None else b''
    except RequestDataTooBig as exc:
        raise ContractError('payload_too_large', 413) from exc
    except (UnreadablePostError, OSError) as exc:
        raise ContractError() from exc
    if len(raw) > MAX_BODY:
        raise ContractError('payload_too_large', 413)
    try:
        payload = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_object,
                             parse_float=_invalid_json_value, parse_constant=_invalid_json_value)
        _check(isinstance(payload, dict))
        _check_json_tree(payload)
    except (ValueError, RecursionError) as exc:
        raise ContractError() from exc
    return raw, payload


def _text(value, limit, *, optional=False, empty=False, bytes_limit=None):
    if optional and value is None:
        return
    _check(isinstance(value, str) and (bool(value) or empty) and len(value) <= limit)
    if bytes_limit is not None:
        _check(len(value.encode('utf-8')) <= bytes_limit)


def _int(value, minimum=0, maximum=MAX_SEQ, *, optional=False):
    if optional and value is None:
        return
    _check(type(value) is int and minimum <= value <= maximum)


def _enum(value, choices):
    _check(isinstance(value, str) and value in choices)


def _code(value):
    _check(isinstance(value, str) and _CODE_PATTERN.fullmatch(value))


def _uuid(value):
    _text(value, 36)
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ContractError() from exc
    _check(str(parsed) == value)
    return parsed


def _time(value, *, optional=False):
    if value is None and optional:
        return None
    _check(isinstance(value, str) and _ISO_TIME.fullmatch(value))
    try:
        parsed = datetime.fromisoformat(value)
        # Keep operations at the representable calendar edges safe after offsets.
        _check(2 <= parsed.year <= 9998)
        return parsed
    except ValueError as exc:
        raise ContractError() from exc


def _decimal(value, *, optional=False, maximum=None):
    if optional and value is None:
        return
    _text(value, 32)
    _check(_DECIMAL.fullmatch(value))
    if maximum is not None:
        _check(0 <= Decimal(value) <= maximum)


def _object(value):
    _check(isinstance(value, dict))
    return value


def _list(value, maximum, minimum=0):
    _check(isinstance(value, list) and minimum <= len(value) <= maximum)
    return value


def _hash(value):
    _check(isinstance(value, str) and bool(re.fullmatch(r'[0-9a-f]{64}', value)))


def validate_envelope(payload):
    if payload.get('contract') != CONTRACT:
        raise ContractError('contract_unsupported')
    station_id = payload.get('station_id')
    _check(isinstance(station_id, str) and STATION_ID_PATTERN.fullmatch(station_id))
    return _uuid(payload.get('database_id'))


def validate_ingest(payload):
    batch_id = _uuid(payload.get('batch_id'))
    events = _list(payload.get('events'), 200, 1)
    timestamps = []
    previous_seq = 0
    for index, event in enumerate(events):
        try:
            _object(event)
            _int(event.get('seq'), previous_seq + 1)
            previous_seq = event['seq']
            timestamps.append(_validate_event(event))
        except ContractError as exc:
            raise ContractError(event_index=index) from exc
    return batch_id, timestamps


def _validate_event(event):
    occurred_at = _time(event.get('occurred_at'))
    app = event.get('app')
    _enum(app, APP_TYPES)
    event_type = event.get('type')
    _enum(event_type, COMMON_TYPES | APP_TYPES[app])
    _enum(event.get('mode'), MODES)
    _enum(event.get('result'), RESULTS)
    _code(event.get('reason'))
    for field in ('app_version', 'agent_version', 'config_version'):
        # With legacy records the producer may not know the original version.
        _text(event.get(field), 64, optional=True)
    for field in ('part_no', 'serial', 'status_raw'):
        _text(event.get(field), 128, optional=True, empty=True)
    _text(event.get('barcode'), 256, optional=True, empty=True, bytes_limit=256)
    _text(event.get('device'), 64, optional=True)
    refs = _object(event.get('ref', {}))
    _check(len(refs) <= 8)
    for key, value in refs.items():
        _code(key)
        _text(value, 128)
    if 'measure' in event:
        measure = _object(event['measure'])
        _decimal(measure.get('value'))
        _enum(measure.get('unit'), {'g', '%'})
        for field in ('expected', 'tolerance'):
            _decimal(measure.get(field), optional=True)
    for evidence in _list(event.get('evidence', []), 4):
        _object(evidence)
        _code(evidence.get('kind'))
        _text(evidence.get('id'), 128)
        if 'sha256' in evidence:
            _hash(evidence['sha256'])
    detail = _object(event.get('detail', {}))
    _check_json_tree(detail, max_depth=4)
    _check(len(json.dumps(detail, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) <= 2048)
    if event_type in APP_TYPES[app] and event['mode'] != 'unknown' and not refs.get('source_key'):
        for field in ('app_version', 'agent_version', 'config_version'):
            _text(event.get(field), 64)
        work_ref = WORK_REFERENCES.get(event_type)
        if work_ref:
            _check(work_ref in refs)
        if event_type == 'label.dispatched':
            _check('job_id' in refs or ('job_ids' in detail and 'row_id' in detail))
        if event_type == 'label.reread' and event['reason'] == 'reread_match':
            _check(detail.get('label_origin') in ('local', 'external', 'unknown'))
            if detail['label_origin'] == 'local':
                _check('job_id' in refs)
        if event_type == 'capture.single':
            _text(detail.get('capture_id'), 128)
    if 'seen_before_reset' in detail:
        _check(app == 'barcode' and event_type == 'scan.recorded' and event['result'] == 'ok'
               and type(detail['seen_before_reset']) is bool)
    if 'label_origin' in detail:
        _enum(detail['label_origin'], {'local', 'external', 'unknown'})
    if 'job_ids' in detail:
        job_ids = _list(detail['job_ids'], 3, 1)
        for job_id in job_ids:
            _text(job_id, 128)
        _check(len(set(job_ids)) == len(job_ids))
    if 'row_id' in detail:
        _text(detail['row_id'], 128)
    if 'quantity' in detail:
        _int(detail['quantity'], 1)
    if 'payload_sha256' in detail:
        _hash(detail['payload_sha256'])
    if 'products' in event or event_type == 'vision.batch':
        _check(event_type == 'vision.batch')
        validate_products(event, detail)
    return occurred_at


def validate_products(event, detail):
    slots = detail.get('slot_count')
    _int(slots, 1, 16)
    products = _list(event.get('products'), slots, slots)
    seen = set()
    for product in products:
        _object(product)
        position = product.get('position')
        _int(position, 1, slots)
        _check(position not in seen)
        seen.add(position)
        _enum(product.get('result'), {'ok', 'ng'})
        _text(product.get('barcode'), 256, optional=True, bytes_limit=256)
        reasons = _list(product.get('reasons'), 5)
        for reason in reasons:
            _enum(reason, {'point_1', 'point_2', 'unreadable', 'multiple', 'duplicate'})
        _check(len(set(reasons)) == len(reasons))
        for field in ('point_1_percent', 'point_2_percent'):
            _decimal(product.get(field), maximum=100)


def validate_heartbeat(payload):
    heartbeat_id = _uuid(payload.get('heartbeat_id'))
    _uuid(payload.get('session_id'))
    _int(payload.get('heartbeat_seq'), 1)
    _time(payload.get('started_at'))
    client_at = _time(payload.get('client_at'))
    _text(payload.get('agent_version'), 64)
    seen_apps = set()
    for app in _list(payload.get('apps'), 16):
        _object(app)
        name = app.get('app')
        _enum(name, APP_TYPES)
        _check(name not in seen_apps)
        seen_apps.add(name)
        _text(app.get('version'), 64, optional=True)
        _enum(app.get('mode'), MODES)
        _enum(app.get('state'), APP_STATES)
        _time(app.get('last_work_at'), optional=True)
    seen_devices = set()
    for device in _list(payload.get('devices'), 64):
        _object(device)
        _enum(device.get('app'), APP_TYPES)
        _text(device.get('device'), 64)
        key = (device['app'], device['device'])
        _check(key not in seen_devices)
        seen_devices.add(key)
        _enum(device.get('state'), DEVICE_STATES)
        _time(device.get('last_input_at'), optional=True)
    outbox = _object(payload.get('outbox'))
    _int(outbox.get('pending_count'), optional=True)
    _time(outbox.get('oldest_occurred_at'), optional=True)
    _time(outbox.get('last_ack_at'), optional=True)
    _enum(outbox.get('state'), OUTBOX_STATES)
    _enum(outbox.get('coverage'), {'known', 'partial', 'unknown'})
    if outbox.get('last_error_code') is not None:
        _code(outbox['last_error_code'])
    resources = _object(payload.get('resources'))
    for field in ('disk_free_bytes', 'ledger_bytes', 'rss_bytes'):
        _int(resources.get(field), optional=True)
    _decimal(resources.get('cpu_pct'), optional=True)
    return heartbeat_id, client_at
