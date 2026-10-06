"""Fixed callback failure reasons; never serialize exception/provider text."""
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
