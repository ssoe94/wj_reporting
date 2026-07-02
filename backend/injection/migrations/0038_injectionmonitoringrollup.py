from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0037_injectionmonitoringrecord_machine_timestamp_index'),
    ]

    operations = [
        migrations.CreateModel(
            name='InjectionMonitoringRollup',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('machine_name', models.CharField(max_length=50, verbose_name='Machine Name')),
                ('device_code', models.CharField(db_index=True, max_length=100, verbose_name='Device Code')),
                ('bucket_start', models.DateTimeField(db_index=True, verbose_name='Bucket Start')),
                ('bucket_minutes', models.PositiveSmallIntegerField(db_index=True, verbose_name='Bucket Minutes')),
                ('shot_count', models.FloatField(default=0, verbose_name='Shot Count')),
                ('active_minutes', models.FloatField(default=0, verbose_name='Active Minutes')),
                ('sample_count', models.PositiveIntegerField(default=0, verbose_name='Sample Count')),
                ('start_capacity', models.FloatField(blank=True, null=True, verbose_name='Start Capacity')),
                ('end_capacity', models.FloatField(blank=True, null=True, verbose_name='End Capacity')),
                ('max_power_kwh', models.FloatField(blank=True, null=True, verbose_name='Max Power (kWh)')),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': 'Injection monitoring rollup',
                'verbose_name_plural': 'Injection monitoring rollups',
                'ordering': ['-bucket_start', 'machine_name'],
                'unique_together': {('device_code', 'bucket_start', 'bucket_minutes')},
            },
        ),
        migrations.AddIndex(
            model_name='injectionmonitoringrollup',
            index=models.Index(fields=['bucket_minutes', 'bucket_start'], name='inj_roll_bucket_idx'),
        ),
        migrations.AddIndex(
            model_name='injectionmonitoringrollup',
            index=models.Index(fields=['machine_name', 'bucket_start'], name='inj_roll_machine_idx'),
        ),
    ]
