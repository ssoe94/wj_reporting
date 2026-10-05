from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name='OAuthAttempt',
            fields=[
                ('nonce_digest', models.CharField(editable=False, max_length=64, primary_key=True, serialize=False)),
                ('actor_id', models.PositiveBigIntegerField(db_index=True, editable=False)),
                ('session_digest', models.CharField(editable=False, max_length=64)),
                ('policy_digest', models.CharField(editable=False, max_length=64)),
                ('code_digest', models.CharField(max_length=64, unique=True, null=True, editable=False)),
                ('expected_user_id', models.CharField(max_length=19, editable=False)),
                ('status', models.CharField(default='pending', max_length=16)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('expires_at', models.DateTimeField()),
                ('consumed_at', models.DateTimeField(null=True)),
                ('verified_at', models.DateTimeField(null=True)),
                ('error_code', models.CharField(blank=True, default='', max_length=64)),
            ],
            options={'default_permissions': ()},
        ),
    ]
