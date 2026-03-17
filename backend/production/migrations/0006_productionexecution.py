from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('production', '0005_merge_20260129_1559'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductionExecution',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('plan_date', models.DateField(db_index=True)),
                ('plan_type', models.CharField(db_index=True, max_length=20)),
                ('machine_name', models.CharField(db_index=True, max_length=100)),
                ('part_no', models.CharField(blank=True, db_index=True, default='', max_length=100)),
                ('lot_no', models.CharField(blank=True, max_length=100, null=True)),
                ('sequence', models.IntegerField(default=-1)),
                ('model_name', models.CharField(blank=True, max_length=100, null=True)),
                ('actual_qty', models.IntegerField(default=0)),
                ('defect_qty', models.IntegerField(default=0)),
                ('idle_time', models.IntegerField(default=0)),
                ('personnel_count', models.FloatField(default=0)),
                ('operating_ct', models.FloatField(blank=True, null=True)),
                ('start_datetime', models.DateTimeField(blank=True, null=True)),
                ('end_datetime', models.DateTimeField(blank=True, null=True)),
                ('note', models.TextField(blank=True)),
                ('status', models.CharField(choices=[('pending', 'Pending'), ('running', 'Running'), ('completed', 'Completed'), ('paused', 'Paused')], default='pending', max_length=20)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('updated_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='production_executions', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['plan_date', 'machine_name', 'sequence'],
                'indexes': [models.Index(fields=['plan_date', 'plan_type'], name='production__plan_da_997e03_idx'), models.Index(fields=['plan_type', 'machine_name'], name='production__plan_ty_983761_idx')],
                'unique_together': {('plan_date', 'plan_type', 'machine_name', 'part_no', 'lot_no', 'sequence')},
            },
        ),
    ]
