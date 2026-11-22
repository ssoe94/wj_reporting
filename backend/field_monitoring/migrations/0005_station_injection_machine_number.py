from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('field_monitoring', '0004_issuer_retained_floor')]

    operations = [
        migrations.AddField(
            model_name='fieldstation',
            name='injection_machine_number',
            field=models.PositiveSmallIntegerField(
                null=True, blank=True, validators=[MinValueValidator(1), MaxValueValidator(17)],
            ),
        ),
        migrations.AddConstraint(
            model_name='fieldstation',
            constraint=models.CheckConstraint(
                condition=models.Q(injection_machine_number__isnull=True) | models.Q(
                    injection_machine_number__range=(1, 17)
                ),
                name='field_station_injection_machine_range',
            ),
        ),
    ]
