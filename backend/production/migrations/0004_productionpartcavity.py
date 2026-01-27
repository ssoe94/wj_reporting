from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('production', '0003_change_sequence_default'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductionPartCavity',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('part_no', models.CharField(db_index=True, max_length=100, unique=True)),
                ('cavity', models.PositiveSmallIntegerField(default=1)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['part_no'],
            },
        ),
    ]
