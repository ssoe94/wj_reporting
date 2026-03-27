from django.db import migrations, models


def halve_machine_3_capacity(apps, schema_editor):
    InjectionMonitoringRecord = apps.get_model('injection', 'InjectionMonitoringRecord')
    InjectionMonitoringRecord.objects.filter(
        machine_name='3호기',
        capacity__isnull=False,
    ).update(capacity=models.F('capacity') * 0.5)


class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0035_update_monitoring_machine_name_to_hogi'),
    ]

    operations = [
        migrations.RunPython(halve_machine_3_capacity, migrations.RunPython.noop),
    ]
