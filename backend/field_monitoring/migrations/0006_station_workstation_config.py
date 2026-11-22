from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('field_monitoring', '0005_station_production_binding')]

    operations = [
        migrations.AddField(
            model_name='fieldstation', name='workstation',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
