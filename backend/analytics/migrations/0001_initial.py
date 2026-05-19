import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name='FactExceptionEvent',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('source', models.CharField(db_index=True, default='production_mart', max_length=50)),
                ('source_key', models.CharField(db_index=True, max_length=255, unique=True)),
                ('business_date', models.DateField(db_index=True)),
                ('process', models.CharField(blank=True, db_index=True, default='', max_length=20)),
                ('exception_type', models.CharField(db_index=True, max_length=80)),
                ('severity', models.CharField(choices=[('info', 'Info'), ('warning', 'Warning'), ('critical', 'Critical')], db_index=True, default='warning', max_length=20)),
                ('status', models.CharField(choices=[('open', 'Open'), ('acknowledged', 'Acknowledged'), ('resolved', 'Resolved'), ('ignored', 'Ignored')], db_index=True, default='open', max_length=20)),
                ('equipment_key', models.CharField(blank=True, db_index=True, default='', max_length=50)),
                ('equipment_label', models.CharField(blank=True, default='', max_length=100)),
                ('part_no', models.CharField(blank=True, db_index=True, default='', max_length=100)),
                ('title', models.CharField(max_length=200)),
                ('detail', models.TextField(blank=True, default='')),
                ('source_payload', models.JSONField(blank=True, default=dict)),
                ('detected_at', models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ('resolved_at', models.DateTimeField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['-business_date', 'status', 'severity', 'exception_type', 'equipment_key'],
            },
        ),
        migrations.CreateModel(
            name='MartEquipmentDailyProgress',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('business_date', models.DateField(db_index=True)),
                ('process', models.CharField(db_index=True, max_length=20)),
                ('equipment_key', models.CharField(db_index=True, max_length=50)),
                ('equipment_label', models.CharField(blank=True, default='', max_length=100)),
                ('equipment_name', models.CharField(blank=True, default='', max_length=200)),
                ('planned_qty', models.IntegerField(default=0)),
                ('actual_qty', models.IntegerField(default=0)),
                ('gap_qty', models.IntegerField(default=0)),
                ('progress_rate', models.FloatField(default=0)),
                ('recent_60m_shots', models.IntegerField(default=0)),
                ('recent_60m_avg_ct_sec', models.FloatField(blank=True, null=True)),
                ('is_running', models.BooleanField(default=False)),
                ('completed_count', models.IntegerField(default=0)),
                ('in_progress_count', models.IntegerField(default=0)),
                ('pending_count', models.IntegerField(default=0)),
                ('source_payload', models.JSONField(blank=True, default=dict)),
                ('generated_at', models.DateTimeField(auto_now=True, db_index=True)),
            ],
            options={
                'ordering': ['business_date', 'process', 'equipment_key'],
                'unique_together': {('business_date', 'process', 'equipment_key')},
            },
        ),
        migrations.CreateModel(
            name='MartPartDailyProgress',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('business_date', models.DateField(db_index=True)),
                ('process', models.CharField(db_index=True, max_length=20)),
                ('equipment_key', models.CharField(db_index=True, max_length=50)),
                ('equipment_label', models.CharField(blank=True, default='', max_length=100)),
                ('part_no', models.CharField(db_index=True, max_length=100)),
                ('model_name', models.CharField(blank=True, default='', max_length=100)),
                ('lot_no', models.CharField(blank=True, default='', max_length=100)),
                ('sequence', models.IntegerField(default=0)),
                ('planned_qty', models.IntegerField(default=0)),
                ('actual_qty', models.IntegerField(default=0)),
                ('gap_qty', models.IntegerField(default=0)),
                ('progress_rate', models.FloatField(default=0)),
                ('cavity', models.IntegerField(default=1)),
                ('status', models.CharField(blank=True, db_index=True, default='pending', max_length=30)),
                ('source_payload', models.JSONField(blank=True, default=dict)),
                ('generated_at', models.DateTimeField(auto_now=True, db_index=True)),
            ],
            options={
                'ordering': ['business_date', 'process', 'equipment_key', 'sequence', 'part_no'],
                'unique_together': {('business_date', 'process', 'equipment_key', 'part_no', 'lot_no', 'sequence')},
            },
        ),
        migrations.CreateModel(
            name='MartProductionDailyProgress',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('business_date', models.DateField(db_index=True)),
                ('process', models.CharField(choices=[('injection', 'Injection'), ('machining', 'Machining')], db_index=True, max_length=20)),
                ('range_start', models.DateTimeField()),
                ('range_end', models.DateTimeField()),
                ('reference_time', models.DateTimeField(blank=True, null=True)),
                ('source_latest_at', models.DateTimeField(blank=True, null=True)),
                ('planned_qty', models.IntegerField(default=0)),
                ('actual_qty', models.IntegerField(default=0)),
                ('gap_qty', models.IntegerField(default=0)),
                ('progress_rate', models.FloatField(default=0)),
                ('time_progress_rate', models.FloatField(blank=True, null=True)),
                ('status', models.CharField(choices=[('ahead', 'Ahead'), ('on_track', 'On Track'), ('behind', 'Behind'), ('no_plan', 'No Plan')], db_index=True, default='no_plan', max_length=20)),
                ('active_equipment_count', models.IntegerField(default=0)),
                ('running_equipment_count', models.IntegerField(default=0)),
                ('total_equipment_count', models.IntegerField(default=0)),
                ('source_row_counts', models.JSONField(blank=True, default=dict)),
                ('used_data', models.JSONField(blank=True, default=list)),
                ('calculation_basis', models.JSONField(blank=True, default=list)),
                ('warnings', models.JSONField(blank=True, default=list)),
                ('generated_at', models.DateTimeField(auto_now=True, db_index=True)),
            ],
            options={
                'ordering': ['-business_date', 'process'],
                'unique_together': {('business_date', 'process')},
            },
        ),
        migrations.AddIndex(
            model_name='factexceptionevent',
            index=models.Index(fields=['business_date', 'status'], name='analytics_f_busines_dc95ff_idx'),
        ),
        migrations.AddIndex(
            model_name='factexceptionevent',
            index=models.Index(fields=['business_date', 'process', 'exception_type'], name='analytics_f_busines_a391e8_idx'),
        ),
        migrations.AddIndex(
            model_name='factexceptionevent',
            index=models.Index(fields=['status', 'severity'], name='analytics_f_status_973d94_idx'),
        ),
        migrations.AddIndex(
            model_name='martequipmentdailyprogress',
            index=models.Index(fields=['business_date', 'process', 'gap_qty'], name='analytics_m_busines_8a7796_idx'),
        ),
        migrations.AddIndex(
            model_name='martequipmentdailyprogress',
            index=models.Index(fields=['process', 'equipment_key'], name='analytics_m_process_886f93_idx'),
        ),
        migrations.AddIndex(
            model_name='martpartdailyprogress',
            index=models.Index(fields=['business_date', 'process', 'status'], name='analytics_m_busines_5e9987_idx'),
        ),
        migrations.AddIndex(
            model_name='martpartdailyprogress',
            index=models.Index(fields=['part_no', 'business_date'], name='analytics_m_part_no_6e93d8_idx'),
        ),
        migrations.AddIndex(
            model_name='martproductiondailyprogress',
            index=models.Index(fields=['business_date', 'status'], name='analytics_m_busines_9fedfd_idx'),
        ),
        migrations.AddIndex(
            model_name='martproductiondailyprogress',
            index=models.Index(fields=['process', 'business_date'], name='analytics_m_process_7643b5_idx'),
        ),
    ]
