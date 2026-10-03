"""One-use OAuth correlation. Never persist an authorization code or token."""
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
