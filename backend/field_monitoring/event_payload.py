"""Store one copy of each losslessly reconstructable normalized wire field."""


_REQUIRED_COLUMNS = {
    'seq': 'seq', 'app': 'app', 'type': 'event_type', 'mode': 'mode',
    'result': 'result', 'reason': 'reason',
}
_OPTIONAL_COLUMNS = ('barcode', 'serial', 'part_no')
WIRE_PAYLOAD_COLUMNS = (*_REQUIRED_COLUMNS.values(), *_OPTIONAL_COLUMNS, 'job_id', 'payload')


def compact_payload(event):
    payload = dict(event)
    for key in _REQUIRED_COLUMNS:
        del payload[key]
    for key in _OPTIONAL_COLUMNS:
        # Distinguish omission, null and an explicitly supplied empty string.
        if payload.get(key):
            del payload[key]
    if 'job_id' in payload.get('ref', {}):
        payload['ref'] = {key: value for key, value in payload['ref'].items() if key != 'job_id'}
    # Keep occurred_at in its original wire spelling, including the time zone.
    return payload


def event_references(record):
    refs = record.payload.get('ref', {})
    if 'seq' not in record.payload and record.job_id:
        return {**refs, 'job_id': record.job_id}
    return refs


def wire_payload(record):
    # All legacy envelopes carried a sequence. Its absence marks the compact
    # representation without requiring a replacement key or a data migration.
    if 'seq' in record.payload:
        return record.payload
    event = dict(record.payload)
    for key, column in _REQUIRED_COLUMNS.items():
        event[key] = getattr(record, column)
    for key in _OPTIONAL_COLUMNS:
        value = getattr(record, key)
        if value:
            event[key] = value
    if 'ref' in event:
        event['ref'] = event_references(record)
    return event
