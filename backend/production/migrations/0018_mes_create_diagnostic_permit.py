import datetime
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('production', '0017_mes_create_diagnostic')]
    operations = [
        migrations.CreateModel(
            name='MesCreateDiagnosticPermit',
            fields=[
                ('request', models.OneToOneField(on_delete=django.db.models.deletion.PROTECT,
                    primary_key=True, related_name='approval', serialize=False, to='production.mescreatediagnostic')),
                ('snapshot', models.JSONField()),
                ('snapshot_digest', models.CharField(max_length=64)),
                ('approved_at', models.DateTimeField()),
                ('expires_at', models.DateTimeField()),
                ('auth_app_attempt', models.PositiveSmallIntegerField(default=0)),
                ('auth_oauth_attempt', models.CharField(blank=True, max_length=64)),
                ('auth_claimed_at', models.DateTimeField(null=True)),
                ('auth_completed_at', models.DateTimeField(null=True)),
            ],
            options={'default_permissions': (), 'constraints': [
                models.CheckConstraint(condition=models.Q(expires_at__gt=models.F('approved_at')) &
                    models.Q(expires_at__lte=models.F('approved_at') + datetime.timedelta(minutes=30)),
                    name='mes_diagnostic_permit_short'),
                models.CheckConstraint(condition=models.Q(auth_app_attempt__in=[0, 1]),
                    name='mes_diagnostic_app_max_one'),
            ]},
        ),
    ]
