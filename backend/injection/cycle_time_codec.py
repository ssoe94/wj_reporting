"""Lossless storage encoding for hourly C/T summaries and their audit evidence."""
import base64
import hashlib
import json
import zlib

FORMAT = 'ct-zlib-json-v1'
MAX_BYTES = 16 * 1024 * 1024


def serialized(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def unpack(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid C/T storage object')
    if value.get('_codec') != FORMAT:
        return value
    decoder = zlib.decompressobj()
    raw = decoder.decompress(base64.b64decode(value['data'], validate=True), MAX_BYTES + 1)
    if len(raw) > MAX_BYTES or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError('Invalid or oversized C/T compressed evidence')
    if hashlib.sha256(raw).hexdigest() != value['sha256']:
        raise ValueError('C/T compressed evidence checksum mismatch')
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError('Invalid decoded C/T object')
    return result


def pack(value):
    original = unpack(value)
    raw = serialized(original)
    if len(raw) > MAX_BYTES:
        raise ValueError('C/T evidence exceeds compression size limit')
    encoded = {'_codec': FORMAT, 'sha256': hashlib.sha256(raw).hexdigest(),
               'data': base64.b64encode(zlib.compress(raw, level=9)).decode('ascii')}
    if unpack(encoded) != original:
        raise ValueError('C/T compression round-trip verification failed')
    return encoded if len(serialized(encoded)) < len(raw) else original
