import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('field_monitoring', '0003_legacy_archive_events')]

    operations = [
        migrations.CreateModel(
            name='FieldIssuerRetainedFloor',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('namespace', models.CharField(max_length=3)),
                ('part_no', models.CharField(max_length=32)),
                ('date_code', models.CharField(max_length=3)),
                ('print_date', models.DateField()),
                ('serial_floor', models.PositiveIntegerField()),
                ('station', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.PROTECT,
                                              to='field_monitoring.fieldstation')),
            ],
            options={
                'constraints': [
                    models.UniqueConstraint(fields=('station', 'namespace', 'part_no', 'date_code'),
                                            name='field_retained_floor_identity'),
                ],
            },
        ),
    ]
