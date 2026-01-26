from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0033_userprofile_department'),
    ]

    operations = [
        migrations.AddField(
            model_name='injectionmonitoringrecord',
            name='power_kwh',
            field=models.FloatField(blank=True, null=True, verbose_name='Power (kWh)'),
        ),
    ]
