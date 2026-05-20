from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0036_adjust_machine_3_monitoring_capacity'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='injectionmonitoringrecord',
            index=models.Index(fields=['machine_name', 'timestamp'], name='inj_mon_machine_ts_idx'),
        ),
    ]
