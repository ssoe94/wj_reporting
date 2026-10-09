import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('production', '0014_injectionactivityconfirmation'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='MesTaskActionLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('request_id', models.CharField(db_index=True, max_length=36)),
                ('action', models.CharField(choices=[('start', 'Start'), ('resume', 'Resume'), ('pause', 'Pause'), ('close_work_order', 'Close work order')], max_length=30)),
                ('reason', models.CharField(max_length=200)),
                ('machine_number', models.PositiveSmallIntegerField(db_index=True)),
                ('task_id', models.CharField(db_index=True, max_length=20)),
                ('task_code', models.CharField(max_length=100)),
                ('work_order_code', models.CharField(blank=True, default='', max_length=100)),
                ('part_no', models.CharField(blank=True, default='', max_length=100)),
                ('status_before', models.PositiveSmallIntegerField()),
                ('status_after', models.PositiveSmallIntegerField(blank=True, null=True)),
                ('outcome', models.CharField(choices=[('confirmed', 'Confirmed'), ('rejected', 'Rejected'), ('uncertain', 'Uncertain'), ('blocked', 'Blocked')], db_index=True, max_length=20)),
                ('outcome_reason', models.CharField(blank=True, default='', max_length=60)),
                ('mes_code', models.IntegerField(blank=True, null=True)),
                ('mes_sub_code', models.CharField(blank=True, default='', max_length=40)),
                ('mes_message', models.CharField(blank=True, default='', max_length=200)),
                ('need_check', models.SmallIntegerField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True, db_index=True)),
                ('actor', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='mes_task_actions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at', '-id'],
            },
        ),
    ]
