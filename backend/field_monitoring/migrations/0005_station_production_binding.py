from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('field_monitoring', '0004_issuer_retained_floor')]

    operations = [
        migrations.AddField(
            model_name='fieldstation', name='production_process',
            field=models.CharField(
                max_length=9, null=True, blank=True, choices=[('injection', 'injection'), ('assembly', 'assembly')],
            ),
        ),
        migrations.AddField(
            model_name='fieldstation', name='assembly_line',
            field=models.CharField(
                max_length=1, null=True, blank=True, choices=[('A', 'A'), ('B', 'B'), ('C', 'C'), ('D', 'D')],
            ),
        ),
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
                condition=models.Q(production_process__isnull=True, injection_machine_number__isnull=True,
                                   assembly_line__isnull=True) | (
                    models.Q(production_process__isnull=False) & (
                        models.Q(production_process='injection', assembly_line__isnull=True) |
                        (models.Q(production_process='assembly', injection_machine_number__isnull=True) &
                         (models.Q(assembly_line__isnull=True) | models.Q(assembly_line__in=('A', 'B', 'C', 'D'))))
                    )
                ),
                name='field_station_valid_production_binding',
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
