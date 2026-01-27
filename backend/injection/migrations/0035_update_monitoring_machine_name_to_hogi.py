from django.db import migrations


def forwards(apps, schema_editor):
    InjectionMonitoringRecord = apps.get_model('injection', 'InjectionMonitoringRecord')
    table = InjectionMonitoringRecord._meta.db_table
    old = '順戈赴'
    new = '호기'
    schema_editor.execute(
        f"UPDATE {table} SET machine_name = REPLACE(machine_name, %s, %s) WHERE machine_name LIKE %s",
        [old, new, f"%{old}%"],
    )


def backwards(apps, schema_editor):
    InjectionMonitoringRecord = apps.get_model('injection', 'InjectionMonitoringRecord')
    table = InjectionMonitoringRecord._meta.db_table
    old = '호기'
    new = '順戈赴'
    schema_editor.execute(
        f"UPDATE {table} SET machine_name = REPLACE(machine_name, %s, %s) WHERE machine_name LIKE %s",
        [old, new, f"%{old}%"],
    )


class Migration(migrations.Migration):
    dependencies = [
        ('injection', '0034_injectionmonitoringrecord_power_kwh'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
