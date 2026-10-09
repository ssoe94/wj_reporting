"""Additive metadata only: never persist links, passwords or request bodies."""
from django.db import models


class ActivationGrant(models.Model):
    selector = models.CharField(max_length=24, primary_key=True, editable=False)
    token_digest = models.CharField(max_length=64, editable=False)
    # Numeric identities preserve replay evidence and compatibility with old code.
    target_id = models.PositiveBigIntegerField(db_index=True, editable=False)
    issuer_id = models.PositiveBigIntegerField(editable=False)
    policy_digest = models.CharField(max_length=64, editable=False)
    credential_digest = models.CharField(max_length=64, editable=False)
    review_reference = models.CharField(max_length=128, editable=False)
    status = models.CharField(max_length=12, default='pending', editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(editable=False)
    consumed_at = models.DateTimeField(null=True, editable=False)
    revoked_at = models.DateTimeField(null=True, editable=False)
    revoked_by = models.PositiveBigIntegerField(null=True, editable=False)

    class Meta:
        default_permissions = ()
        constraints = [models.UniqueConstraint(
            fields=['target_id'], condition=models.Q(status='pending'),
            name='activation_one_pending_target')]

    def __str__(self):
        return f'Activation {self.target_id}: {self.status}'


class ActivationRateBucket(models.Model):
    digest = models.CharField(max_length=64, primary_key=True, editable=False)
    count = models.PositiveIntegerField(default=0, editable=False)
    expires_at = models.DateTimeField(db_index=True, editable=False)

    class Meta:
        default_permissions = ()
