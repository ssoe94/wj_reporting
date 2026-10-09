"""Prepare inert user records; never activate a login, permission or MES mapping.

Call only after configuring Django for the explicitly reviewed database. Input and
returned manifests contain personnel identifiers and belong in private records.
No provider, settings file, mail, token or session operation is performed here.
"""
import hashlib
import json
import re
import unicodedata


class PreparationBlocked(ValueError):
    pass


def _key(value):
    return unicodedata.normalize('NFKC', value).strip().casefold()


def _text(value, limit):
    if (type(value) is not str or not value.strip() or value != value.strip()
            or len(value) > limit or any(unicodedata.category(c).startswith('C') for c in value)):
        raise PreparationBlocked('invalid_manifest_text')
    return value


def validate_manifest(value):
    if type(value) is not dict or set(value) != {'schema', 'review_reference', 'entries'} or type(value['schema']) is not int or value['schema'] != 1:
        raise PreparationBlocked('invalid_manifest')
    _text(value['review_reference'], 200)
    entries = value['entries']
    if type(entries) is not list or not 1 <= len(entries) <= 20:
        raise PreparationBlocked('invalid_entries')
    aliases, mes_ids, mes_codes = set(), set(), set()
    for entry in entries:
        if type(entry) is not dict or set(entry) != {'username', 'display_name', 'mes_user_id', 'mes_user_code'}:
            raise PreparationBlocked('invalid_entry_fields')
        username = _text(entry['username'], 150)
        if not re.fullmatch(r'[A-Za-z0-9_.@+-]+', username):
            raise PreparationBlocked('invalid_username')
        display = _text(entry['display_name'], 150)
        mes_id = entry['mes_user_id']
        if type(mes_id) is not str or not re.fullmatch(r'[1-9][0-9]{0,18}', mes_id) or int(mes_id) > 9223372036854775807:
            raise PreparationBlocked('invalid_mes_user_id')
        code = _text(entry['mes_user_code'], 150)
        current = {_key(username), _key(display)}
        if aliases & current or mes_id in mes_ids or _key(code) in mes_codes:
            raise PreparationBlocked('duplicate_manifest_identity')
        aliases.update(current)
        mes_ids.add(mes_id)
        mes_codes.add(_key(code))
    return value


def manifest_digest(manifest):
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def _profile_permission_fields(Profile):
    from django.db.models import BooleanField
    fields = [f for f in Profile._meta.concrete_fields if f.name.startswith('can_') or f.name == 'is_admin']
    if not fields or any(not isinstance(f, BooleanField) for f in fields):
        raise PreparationBlocked('profile_permission_schema_unreviewed')
    required = {'can_view_injection', 'can_view_assembly', 'can_view_quality',
                'can_view_sales', 'can_view_development', 'is_admin'}
    if not required.issubset({f.name for f in fields}):
        raise PreparationBlocked('profile_permission_schema_unreviewed')
    return [f.name for f in fields]


def _inert(user, entry, Profile, fields):
    if (user.username != entry['username'] or user.first_name != entry['display_name']
            or user.last_name != ''):
        return False
    # Existing active/privileged accounts are collisions. Do not load their
    # email, login history, password hash or profile to establish that fact.
    if user.is_active or user.is_staff or user.is_superuser:
        return False
    if (user.email != '' or user.last_login is not None or user.has_usable_password()
            or user.groups.exists() or user.user_permissions.exists()):
        return False
    profile = Profile.objects.filter(user_id=user.pk).first()
    return bool(
        profile is not None
        and profile.department == '' and not profile.is_using_temp_password
        and not profile.password_reset_required and profile.last_password_change is None
        and all(getattr(profile, name) is False for name in fields))


def _prior_ids(receipt, manifest, digest):
    if receipt is None:
        return {}
    if (type(receipt) is not dict or receipt.get('schema') != 1
            or receipt.get('mode') != 'applied' or receipt.get('runtime_mapping_enabled') is not False
            or receipt.get('manifest_digest') != digest
            or receipt.get('review_reference') != manifest['review_reference']):
        raise PreparationBlocked('reviewed_prior_manifest_mismatch')
    accounts = receipt.get('accounts')
    if type(accounts) is not list or len(accounts) != len(manifest['entries']):
        raise PreparationBlocked('reviewed_prior_manifest_mismatch')
    result, ids = {}, set()
    expected = {e['username']: e for e in manifest['entries']}
    for row in accounts:
        if type(row) is not dict:
            raise PreparationBlocked('reviewed_prior_manifest_mismatch')
        entry = expected.get(row.get('username'))
        user_id = row.get('wj_user_id')
        if (entry is None or any(row.get(k) != v for k, v in entry.items())
                or row.get('mapping_enabled') is not False or type(user_id) is not int
                or user_id < 1 or user_id in ids or entry['username'] in result
                or row.get('state') not in {'created_inactive', 'verified_prior_inactive'}):
            raise PreparationBlocked('reviewed_prior_manifest_mismatch')
        ids.add(user_id)
        result[entry['username']] = user_id
    return result


def _inspect(manifest, users, Profile, fields, prior_ids):
    result = []
    for entry in manifest['entries']:
        aliases = {_key(entry['username']), _key(entry['display_name'])}
        matches = []
        for user in users:
            existing = {user.username, user.first_name, user.last_name, user.get_full_name()}
            if aliases & {_key(name) for name in existing if name.strip()}:
                matches.append(user)
        expected_id = prior_ids.get(entry['username'])
        state, user_id = 'would_create_inactive', None
        if expected_id is not None:
            if len(matches) == 1 and matches[0].pk == expected_id and _inert(matches[0], entry, Profile, fields):
                state, user_id = 'verified_prior_inactive', expected_id
            else:
                state = 'blocked_prior_record_changed'
        elif matches:
            if len(matches) == 1 and _inert(matches[0], entry, Profile, fields):
                state = 'blocked_existing_inactive_unclaimed'
            else:
                state = 'blocked_identity_collision'
        result.append(dict(entry, state=state, wj_user_id=user_id, mapping_enabled=False))
    return result


def prepare_accounts(manifest, *, apply=False, reviewed_prior_manifest=None):
    """Dry-run by default. Only new users are ever written, atomically.

    A prior receipt is an explicit operator-reviewed record, not proof inferred
    from a matching name. Existing accounts are never adopted, repaired or updated.
    """
    from django.contrib.auth import get_user_model
    from django.db import connection, transaction
    from injection.models import UserProfile

    if type(apply) is not bool:
        raise PreparationBlocked('invalid_apply_flag')
    manifest = validate_manifest(manifest)
    digest = manifest_digest(manifest)
    User = get_user_model()
    fields = _profile_permission_fields(UserProfile)
    prior_ids = _prior_ids(reviewed_prior_manifest, manifest, digest)

    def inspect():
        # Only names are needed for the broad collision scan. Deferred state is
        # read solely for a matching candidate, with active accounts rejected first.
        users = list(User.objects.only('pk', 'username', 'first_name', 'last_name').order_by('pk'))
        return _inspect(manifest, users, UserProfile, fields, prior_ids)

    def output(accounts):
        return dict(schema=1, mode='applied' if apply else 'dry_run',
                    review_reference=manifest['review_reference'], manifest_digest=digest,
                    runtime_mapping_enabled=False, accounts=accounts,
                    blocked=any(row['state'].startswith('blocked_') for row in accounts))

    if not apply:
        return output(inspect())
    with transaction.atomic():
        if connection.vendor == 'postgresql':
            # Serialize against ordinary account inserts too: auth_user's default
            # unique constraint alone does not reject case-insensitive collisions.
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL lock_timeout = '5s'")
                cursor.execute("SET LOCAL statement_timeout = '15s'")
                cursor.execute('LOCK TABLE ' + connection.ops.quote_name(User._meta.db_table)
                               + ' IN SHARE ROW EXCLUSIVE MODE')
        elif connection.vendor != 'sqlite':
            raise PreparationBlocked('database_locking_unreviewed')
        accounts = inspect()
        if any(row['state'].startswith('blocked_') for row in accounts):
            raise PreparationBlocked('batch_identity_conflict_no_changes')
        for row in accounts:
            if row['state'] == 'verified_prior_inactive':
                continue
            user = User(username=row['username'], first_name=row['display_name'],
                        last_name='', email='', is_active=False, is_staff=False, is_superuser=False)
            user.set_unusable_password()
            user.save(force_insert=True)
            # The existing post_save signal grants five view flags to a new
            # nonstaff user. Reset only this newly created profile in this same
            # transaction. A queryset update avoids unrelated MES revoke signals.
            if UserProfile.objects.filter(user_id=user.pk).update(**{name: False for name in fields}) != 1:
                raise PreparationBlocked('new_profile_missing')
            user.refresh_from_db()
            if not _inert(user, row, UserProfile, fields):
                raise PreparationBlocked('new_account_not_inert_batch_rolled_back')
            row.update(wj_user_id=user.pk, state='created_inactive')
        return output(accounts)
