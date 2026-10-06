"""Fixed callback failure reasons; never serialize exception/provider text."""
from datetime import datetime, timedelta, timezone

from .continuity import ContinuityBlocked
from .identity import FAILURE_CODES as IDENTITY_FAILURE_CODES, safe_failure_code


VAULT_FAILURE_CODES = frozenset({
    'actor_unavailable', 'identity_mapping_unverified', 'vault_key_unavailable',
    'storage_disabled', 'storage_policy_unreviewed', 'credential_invalid',
    'login_unavailable', 'identity_unverified', 'identity_mismatch',
    'credential_expired',
})
CONTINUITY_FAILURE_CODES = frozenset({
    'expiry_contract_unverified', 'expiry_value_invalid', 'exchange_clock_invalid',
    'provider_token_expired',
})
CALLBACK_FAILURE_CODES = IDENTITY_FAILURE_CODES | VAULT_FAILURE_CODES | CONTINUITY_FAILURE_CODES

MAX_EXPIRY_SECONDS = 253402300799  # Last whole Unix second representable by datetime.
EXPIRY_TYPES = frozenset({'integer', 'boolean', 'null', 'string', 'float', 'other'})
CLOCK_BOUNDS = frozenset({'within_300s', 'over_300s', 'reversed', 'unavailable'})
EXPIRY_MODES = frozenset({'relative_seconds', 'unix_seconds', 'conservative_minimum'})
EXPIRY_TIMESTAMPS = ('request_started_at', 'received_at', 'relative_expires_at', 'unix_expires_at')


def _utc_iso(value):
    if type(value) is datetime and value.tzinfo is timezone.utc:
        return value.isoformat(timespec='microseconds')[:-6] + 'Z'
    return None


def _safe_utc_iso(value):
    if type(value) is not str or len(value) != 27 or not value.endswith('Z'):
        return None
    try:
        parsed = datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        return None
    return value if _utc_iso(parsed) == value else None


def safe_expiry_metadata(metadata):
    """Rebuild the optional log field from exact builtin values only."""
    if type(metadata) is not dict:
        return None
    metadata = dict.copy(metadata)
    if any(type(key) is not str for key in metadata):
        return None
    stage = metadata.get('stage')
    kind = metadata.get('expire_type')
    bound = metadata.get('elapsed_bound')
    if (type(stage) is not str or stage != 'credential_storage'
            or type(kind) is not str or kind not in EXPIRY_TYPES
            or type(bound) is not str or bound not in CLOCK_BOUNDS):
        return None
    seconds = metadata.get('expire_seconds')
    elapsed = metadata.get('elapsed_ms')
    result = {'stage': stage, 'expire_type': kind, 'elapsed_bound': bound,
              'expire_seconds': seconds if kind == 'integer' and type(seconds) is int
              and 1 <= seconds <= MAX_EXPIRY_SECONDS else None,
              'elapsed_ms': elapsed if bound == 'within_300s' and type(elapsed) is int
              and 0 <= elapsed <= 300000 else None}
    for key in ('relative_expired', 'unix_expired'):
        value = metadata.get(key)
        result[key] = value if result['expire_seconds'] is not None and type(value) is bool else None
    mode = metadata.get('applied_mode')
    result['applied_mode'] = mode if type(mode) is str and mode in EXPIRY_MODES else 'unavailable'
    for key in EXPIRY_TIMESTAMPS:
        result[key] = _safe_utc_iso(metadata.get(key))
    # Derive the fixed classification again at the logging boundary; never
    # accept a caller's classification or imply provider semantics are known.
    result['interpretation'] = 'unavailable'
    if (result['applied_mode'] != 'unavailable'
            and all(result[key] is not None for key in EXPIRY_TIMESTAMPS)
            and result['relative_expired'] is not None and result['unix_expired'] is not None
            and bound in ('within_300s', 'over_300s')):
        result['interpretation'] = ('interpretation_conflict'
            if result['applied_mode'] == 'conservative_minimum'
            and result['relative_expired'] is False and result['unix_expired'] is True
            else 'not_conflicting')
    return result


def expiry_metadata(raw_expire, *, request_started_at, received_at, applied_mode='unavailable'):
    """Observe both interpretations, without choosing or changing expiry policy."""
    kind = 'other'
    for builtin, label in ((int, 'integer'), (bool, 'boolean'), (type(None), 'null'),
                           (str, 'string'), (float, 'float')):
        if type(raw_expire) is builtin:
            kind = label
            break
    result = {'stage': 'credential_storage', 'expire_type': kind,
              'elapsed_bound': 'unavailable', 'applied_mode': applied_mode,
              'request_started_at': _utc_iso(request_started_at),
              'received_at': _utc_iso(received_at)}
    if type(raw_expire) is int and 1 <= raw_expire <= MAX_EXPIRY_SECONDS:
        result['expire_seconds'] = raw_expire
    # Server UTC datetimes only; never invoke arbitrary tzinfo/subclass hooks.
    if all(type(value) is datetime and value.tzinfo is timezone.utc
           for value in (request_started_at, received_at)):
        elapsed = received_at - request_started_at
        if elapsed < timedelta(0):
            result['elapsed_bound'] = 'reversed'
        elif elapsed > timedelta(seconds=300):
            result['elapsed_bound'] = 'over_300s'
        else:
            result['elapsed_bound'] = 'within_300s'
            result['elapsed_ms'] = elapsed // timedelta(milliseconds=1)
        if 'expire_seconds' in result:
            for key, start in (('relative_expired', request_started_at),
                               ('unix_expired', datetime(1970, 1, 1, tzinfo=timezone.utc))):
                try:
                    deadline = start + timedelta(seconds=raw_expire)
                    result[key] = deadline <= received_at
                    result[key.replace('_expired', '_expires_at')] = _utc_iso(deadline)
                except OverflowError:
                    pass
    return safe_expiry_metadata(result)


def failure_expiry_metadata(error, fallback=None):
    """Only the exact resolver exception may supply applied-policy evidence."""
    if (type(error) is ContinuityBlocked and len(error.args) == 1
            and type(error.args[0]) is str and error.args[0] in CONTINUITY_FAILURE_CODES):
        attributes = error.__dict__
        if type(attributes) is dict and all(type(key) is str for key in attributes):
            observed = safe_expiry_metadata(attributes.get('expiry_diagnostic'))
            if observed is not None:
                return observed
    observed = safe_expiry_metadata(fallback)
    if observed is not None:
        observed['applied_mode'] = 'unavailable'
        return safe_expiry_metadata(observed)
    return None


def safe_callback_failure_code(error):
    # Import only at the callback boundary: vault -> client -> identity must
    # remain independent of callback diagnostics and vault initialization.
    from .continuity import ContinuityBlocked
    from .vault import VaultBlocked

    if type(error) is VaultBlocked:
        allowed = VAULT_FAILURE_CODES
    elif type(error) is ContinuityBlocked:
        allowed = CONTINUITY_FAILURE_CODES
    else:
        return safe_failure_code(error)
    if (len(error.args) == 1 and type(error.args[0]) is str
            and error.args[0] in allowed):
        return error.args[0]
    return 'identity_verification_failed'
