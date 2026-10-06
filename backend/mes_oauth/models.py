"""One-use OAuth digests and optional encrypted, server-only user credentials."""
from django.db import models


class OAuthAttempt(models.Model):
    # Only the digest of the random, HttpOnly browser cookie is stored.
    nonce_digest = models.CharField(max_length=64, primary_key=True, editable=False)
    # Deliberately no FK: rollback to the old app must not block account deletion,
    # and deleting an account must not erase consumed-code replay protection.
    actor_id = models.PositiveBigIntegerField(db_index=True, editable=False)
    session_digest = models.CharField(max_length=64, editable=False)
    policy_digest = models.CharField(max_length=64, editable=False)
    code_digest = models.CharField(max_length=64, unique=True, null=True, editable=False)
    expected_user_id = models.CharField(max_length=19, editable=False)
    status = models.CharField(max_length=16, default='pending')
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True)
    verified_at = models.DateTimeField(null=True)
    error_code = models.CharField(max_length=64, default='', blank=True)

    class Meta:
        default_permissions = ()


class MESLoginSession(models.Model):
    """Hashed WJ login identity; a revoked login cannot reconnect by replay."""
    digest = models.CharField(max_length=64, primary_key=True, editable=False)
    actor_id = models.PositiveBigIntegerField(db_index=True, editable=False)
    authorization_digest = models.CharField(max_length=64, editable=False)
    expires_at = models.DateTimeField()  # Immutable signed login identity anchor.
    session_version = models.PositiveSmallIntegerField(null=True)
    last_activity_at = models.DateTimeField(null=True)
    idle_expires_at = models.DateTimeField(null=True)
    revoked_at = models.DateTimeField(null=True)
    revision = models.PositiveBigIntegerField(default=1)

    class Meta:
        default_permissions = ()


class MESLoginTicket(models.Model):
    """One-use top-level session bridge. Never stores the ticket or JWT."""
    digest = models.CharField(max_length=64, primary_key=True, editable=False)
    actor_id = models.PositiveBigIntegerField(editable=False)
    login_digest = models.CharField(max_length=64, editable=False)
    authorization_digest = models.CharField(max_length=64, editable=False)
    expires_at = models.DateTimeField()
    consumed_at = models.DateTimeField(null=True)
    login_revision = models.PositiveBigIntegerField(default=1)

    class Meta:
        default_permissions = ()


class MESCredential(models.Model):
    """AEAD ciphertext and bound metadata only. No admin or serializer exposure."""
    actor_id = models.PositiveBigIntegerField(primary_key=True, editable=False)
    mes_user_id = models.CharField(max_length=19, editable=False)
    app_id = models.CharField(max_length=19, editable=False)
    tenant_reference = models.CharField(max_length=128, editable=False)
    login_digest = models.CharField(max_length=64, editable=False)
    authorization_digest = models.CharField(max_length=64, editable=False)
    policy_reference = models.CharField(max_length=128, editable=False)
    key_id = models.CharField(max_length=32, editable=False)
    ciphertext = models.BinaryField(editable=False, default=bytes)
    verified_at = models.DateTimeField()
    last_used_at = models.DateTimeField()
    expires_at = models.DateTimeField(db_index=True)
    provider_expires_at = models.DateTimeField()
    idle_expires_at = models.DateTimeField(db_index=True)
    consent_expires_at = models.DateTimeField()
    revoked_at = models.DateTimeField(null=True)
    version = models.PositiveBigIntegerField(default=1, editable=False)

    class Meta:
        default_permissions = ()


class MESCredentialEvent(models.Model):
    """Server actor and fixed actions/reasons only; no request/response payload."""
    actor_id = models.PositiveBigIntegerField(db_index=True, editable=False)
    action = models.CharField(max_length=24, editable=False)
    reason = models.CharField(max_length=64, editable=False)
    created_at = models.DateTimeField(auto_now_add=True, editable=False)

    class Meta:
        default_permissions = ()
