from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(
            name='ActivationGrant',
            fields=[
                ('selector', models.CharField(editable=False, max_length=24, primary_key=True, serialize=False)),
                ('token_digest', models.CharField(editable=False, max_length=64)),
                ('target_id', models.PositiveBigIntegerField(db_index=True, editable=False)),
                ('issuer_id', models.PositiveBigIntegerField(editable=False)),
                ('policy_digest', models.CharField(editable=False, max_length=64)),
                ('credential_digest', models.CharField(editable=False, max_length=64)),
                ('review_reference', models.CharField(editable=False, max_length=128)),
                ('status', models.CharField(default='pending', editable=False, max_length=12)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('expires_at', models.DateTimeField(editable=False)),
                ('consumed_at', models.DateTimeField(editable=False, null=True)),
                ('revoked_at', models.DateTimeField(editable=False, null=True)),
                ('revoked_by', models.PositiveBigIntegerField(editable=False, null=True)),
            ],
            options={'default_permissions': (), 'constraints': [models.UniqueConstraint(
                condition=models.Q(status='pending'), fields=('target_id',), name='activation_one_pending_target')]},
        ),
        migrations.CreateModel(
            name='ActivationRateBucket',
            fields=[
                ('digest', models.CharField(editable=False, max_length=64, primary_key=True, serialize=False)),
                ('count', models.PositiveIntegerField(default=0, editable=False)),
                ('expires_at', models.DateTimeField(db_index=True, editable=False)),
            ],
            options={'default_permissions': ()},
        ),
    ]
