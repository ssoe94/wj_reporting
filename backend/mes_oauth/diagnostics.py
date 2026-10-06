"""Fixed callback failure reasons; never serialize exception/provider text."""
from datetime import datetime, timedelta, timezone

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


def safe_expiry_metadata(metadata):
    """Rebuild the optional log field from exact builtin values only."""
    if type(metadata) is not dict:
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
    return result


def expiry_metadata(raw_expire, *, request_started_at, received_at):
    """Observe both interpretations, without choosing or changing expiry policy."""
    kind = 'other'
    for builtin, label in ((int, 'integer'), (bool, 'boolean'), (type(None), 'null'),
                           (str, 'string'), (float, 'float')):
        if type(raw_expire) is builtin:
            kind = label
            break
    result = {'stage': 'credential_storage', 'expire_type': kind,
              'elapsed_bound': 'unavailable'}
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
                    result[key] = start + timedelta(seconds=raw_expire) <= received_at
                except OverflowError:
                    pass
    return safe_expiry_metadata(result)


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
