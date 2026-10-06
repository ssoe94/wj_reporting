"""Reviewable role preparation for exact, still-inactive quality placeholders.

No activation, password, provider, runtime mapping, setting, permission creation,
mail or session operation. Private input/output receipts are operator-reviewed
records; matching names alone are never proof of an account's provenance.
"""
import re

from quality_account_preparation import (
    PreparationBlocked, _key, _prior_ids, _profile_permission_fields,
    manifest_digest, validate_manifest,
)


ROLE = ('view_inspectionrequest', 'manage_inspectionrequest', 'submit_inspectionrequest')
KIND = 'inactive_quality_role_preparation'
IDENTITY_FIELDS = ('username', 'display_name', 'mes_user_id', 'mes_user_code')


def _source(receipt):
    if (type(receipt) is not dict or type(receipt.get('schema')) is not int
            or receipt.get('schema') != 1 or receipt.get('mode') != 'applied'
            or receipt.get('blocked') is not False or receipt.get('runtime_mapping_enabled') is not False
            or type(receipt.get('accounts')) is not list or not 1 <= len(receipt['accounts']) <= 4):
        raise PreparationBlocked('original_preparation_receipt_required')
    try:
        entries = [{key: row[key] for key in IDENTITY_FIELDS} for row in receipt['accounts']]
        manifest = validate_manifest(dict(schema=1, review_reference=receipt['review_reference'], entries=entries))
        ids = _prior_ids(receipt, manifest, manifest_digest(manifest))
    except (KeyError, TypeError):
        raise PreparationBlocked('original_preparation_receipt_invalid') from None
    if any(type(value) is not int or not 1 <= value <= 2**63 - 1 for value in ids.values()):
        raise PreparationBlocked('original_preparation_receipt_invalid')
    return [dict(entry, wj_user_id=ids[entry['username']]) for entry in entries]


def _permission_rows(lock=False):
    from django.contrib.auth.models import Permission
    query = Permission.objects.filter(content_type__app_label='quality',
        content_type__model='inspectionrequest', codename__in=ROLE).select_related('content_type').order_by('pk')
    if lock:
        query = query.select_for_update()
    rows = list(query)
    if len(rows) != len(ROLE) or {row.codename for row in rows} != set(ROLE):
        raise PreparationBlocked('required_exact_permissions_missing')
    return rows


def _locks():
    from django.contrib.auth import get_user_model
    from django.contrib.auth.models import Group, Permission
    from django.db import connection
    if connection.vendor == 'sqlite':
        return
    if connection.vendor != 'postgresql':
        raise PreparationBlocked('database_locking_unreviewed')
    User = get_user_model()
    tables = sorted({User.groups.through._meta.db_table, User.user_permissions.through._meta.db_table,
                     Group.permissions.through._meta.db_table, Permission._meta.db_table})
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '3s'")
        cursor.execute("SET LOCAL statement_timeout = '15s'")
        # Same permission-tables -> user -> profile order as account activation.
        # Acquire write-compatible locks initially; never upgrade activation's SHARE locks.
        cursor.execute('LOCK TABLE ' + ', '.join(connection.ops.quote_name(name) for name in tables)
                       + ' IN SHARE ROW EXCLUSIVE MODE')
        # Freeze the case-insensitive name collision scan against legacy edits/inserts.
        cursor.execute('LOCK TABLE ' + connection.ops.quote_name(User._meta.db_table)
                       + ' IN SHARE ROW EXCLUSIVE MODE')


def _identity_matches(entries):
    from django.contrib.auth import get_user_model
    users = list(get_user_model().objects.only('pk', 'username', 'first_name', 'last_name'))
    for entry in entries:
        aliases = {_key(entry['username']), _key(entry['display_name'])}
        matches = [user.pk for user in users if aliases & {_key(name) for name in
                   (user.username, user.first_name, user.last_name, user.get_full_name()) if name.strip()}]
        if matches != [entry['wj_user_id']]:
            raise PreparationBlocked('exact_account_identity_collision')


def _state(user, profile, entry, fields, permission_ids, *, prepared):
    if (user is None or user.username != entry['username'] or user.first_name != entry['display_name']
            or user.last_name != '' or user.is_active or user.is_staff or user.is_superuser):
        return False
    if (user.email != '' or user.last_login is not None or user.has_usable_password()
            or user.groups.exists() or profile is None or profile.department != ''
            or profile.is_using_temp_password or profile.password_reset_required
            or profile.last_password_change is not None):
        return False
    desired = set(permission_ids) if prepared else set()
    if set(user.user_permissions.values_list('pk', flat=True)) != desired:
        return False
    return all(getattr(profile, name) is (prepared and name == 'can_view_quality') for name in fields)


def _reviewed_digests(receipt, entries, source_digest, reference, permission_ids):
    if receipt is None:
        return {}
    if (type(receipt) is not dict or receipt.get('schema') != 1 or receipt.get('kind') != KIND
            or receipt.get('mode') != 'applied' or receipt.get('blocked') is not False
            or receipt.get('source_receipt_digest') != source_digest
            or receipt.get('role_review_reference') != reference
            or receipt.get('runtime_mapping_enabled') is not False
            or receipt.get('activation_config_written') is not False
            or receipt.get('permission_ids') != permission_ids
            or type(receipt.get('accounts')) is not list or len(receipt['accounts']) != len(entries)):
        raise PreparationBlocked('reviewed_role_receipt_mismatch')
    expected = {entry['wj_user_id']: entry for entry in entries}
    result, candidates = {}, {}
    for row in receipt['accounts']:
        if type(row) is not dict or type(row.get('wj_user_id')) is not int:
            raise PreparationBlocked('reviewed_role_receipt_mismatch')
        entry = expected.get(row['wj_user_id'])
        value = row.get('policy_digest')
        if (entry is None or any(row.get(key) != value for key, value in entry.items())
                or row['wj_user_id'] in result or type(value) is not str
                or not re.fullmatch(r'[a-f0-9]{64}', value)
                or row.get('state') not in {'prepared_inactive_roles', 'verified_prior_roles'}
                or row.get('mapping_enabled') is not False):
            raise PreparationBlocked('reviewed_role_receipt_mismatch')
        result[row['wj_user_id']] = value
        candidates[str(row['wj_user_id'])] = dict(username=entry['username'], policy_digest=value, reference=reference)
    if receipt.get('account_activation_approved_targets_candidate') != candidates:
        raise PreparationBlocked('reviewed_role_receipt_mismatch')
    return result


def prepare_quality_roles(source_receipt, role_review_reference, *, apply=False, reviewed_role_receipt=None):
    """Prepare only the fixed three permissions; never make an account usable.

    First dry-run reports the proposed permissions, without a hypothetical
    activation fingerprint. A fingerprint is returned only for the actual,
    frozen post-role state. Previously prepared roles need a reviewed receipt
    and an exact post-state match; no existing divergence is repaired.
    """
    from django.contrib.auth import get_user_model
    from django.db import transaction
    from injection.models import UserProfile
    from account_activation.services import policy_digest

    if type(apply) is not bool or type(role_review_reference) is not str or not re.fullmatch(
            r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', role_review_reference):
        raise PreparationBlocked('role_review_reference_invalid')
    entries = _source(source_receipt)
    source_digest = manifest_digest(source_receipt)
    User = get_user_model()
    fields = _profile_permission_fields(UserProfile)

    def run():
        if apply:
            _locks()
        permissions = _permission_rows(lock=apply)
        permission_ids = [row.pk for row in permissions]
        prior = _reviewed_digests(reviewed_role_receipt, entries, source_digest,
                                 role_review_reference, permission_ids)
        _identity_matches(entries)
        ids = sorted(entry['wj_user_id'] for entry in entries)
        users_query = User.objects.filter(pk__in=ids).order_by('pk')
        profiles_query = UserProfile.objects.filter(user_id__in=ids).order_by('user_id')
        if apply:
            users_query = users_query.select_for_update()
            profiles_query = profiles_query.select_for_update()
        users = {user.pk: user for user in users_query}
        profiles = {profile.user_id: profile for profile in profiles_query}
        rows, pending = [], []
        for entry in entries:
            user, profile = users.get(entry['wj_user_id']), profiles.get(entry['wj_user_id'])
            prepared = entry['wj_user_id'] in prior
            if not _state(user, profile, entry, fields, permission_ids, prepared=prepared):
                raise PreparationBlocked('account_role_precondition_changed')
            fingerprint = policy_digest(user, profile) if prepared else None
            if prepared and fingerprint != prior[entry['wj_user_id']]:
                raise PreparationBlocked('reviewed_role_state_changed')
            rows.append(dict(entry, state='verified_prior_roles' if prepared else 'would_prepare_inactive_roles',
                             policy_digest=fingerprint, mapping_enabled=False))
            if not prepared:
                pending.append(entry)
        if apply:
            for entry in pending:
                user_id = entry['wj_user_id']
                # These accounts are locked, inactive and passwordless. Update
                # exactly the approved profile bit and direct join rows without
                # sending unrelated MES revocation signals or changing sessions.
                if UserProfile.objects.filter(user_id=user_id, can_view_quality=False).update(can_view_quality=True) != 1:
                    raise PreparationBlocked('profile_role_write_conflict')
                User.user_permissions.through.objects.bulk_create([
                    User.user_permissions.through(user_id=user_id, permission_id=permission_id)
                    for permission_id in permission_ids])
            for row in rows:
                user = User.objects.get(pk=row['wj_user_id'])
                profile = UserProfile.objects.get(user_id=user.pk)
                if not _state(user, profile, row, fields, permission_ids, prepared=True):
                    raise PreparationBlocked('post_role_state_invalid')
                row['policy_digest'] = policy_digest(user, profile)
                if row['state'] != 'verified_prior_roles':
                    row['state'] = 'prepared_inactive_roles'
        candidate = {str(row['wj_user_id']): dict(username=row['username'],
                     policy_digest=row['policy_digest'], reference=role_review_reference)
                     for row in rows if row['policy_digest'] is not None}
        return dict(schema=1, kind=KIND, mode='applied' if apply else 'dry_run', blocked=False,
            source_receipt_digest=source_digest, role_review_reference=role_review_reference,
            permission_ids=permission_ids, direct_permissions=['quality.' + code for code in ROLE],
            profile_changes={'can_view_quality': True}, runtime_mapping_enabled=False,
            activation_config_written=False, accounts=rows,
            account_activation_approved_targets_candidate=candidate)

    if not apply:
        return run()
    with transaction.atomic():
        return run()
