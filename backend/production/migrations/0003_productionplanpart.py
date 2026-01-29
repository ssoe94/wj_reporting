from django.db import migrations, models


def seed_plan_part_map(apps, schema_editor):
    ProductionPlan = apps.get_model('production', 'ProductionPlan')
    ProductionPlanPart = apps.get_model('production', 'ProductionPlanPart')

    mapping = {}
    for plan in ProductionPlan.objects.exclude(part_no__isnull=True).exclude(part_no__exact=''):
        part_no = (plan.part_no or '').strip().upper()
        if not part_no:
            continue
        model_name = (plan.model_name or '').strip() or None
        key = (plan.plan_type, part_no)
        mapping[key] = model_name

    if not mapping:
        return

    objects = [
        ProductionPlanPart(plan_type=plan_type, part_no=part_no, model_name=model_name)
        for (plan_type, part_no), model_name in mapping.items()
    ]
    ProductionPlanPart.objects.bulk_create(objects, ignore_conflicts=True)


class Migration(migrations.Migration):

    dependencies = [
        ('production', '0002_add_sequence_to_plan'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductionPlanPart',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('plan_type', models.CharField(db_index=True, max_length=20)),
                ('part_no', models.CharField(db_index=True, max_length=100)),
                ('model_name', models.CharField(blank=True, db_index=True, max_length=100, null=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['plan_type', 'part_no'],
                'unique_together': {('plan_type', 'part_no')},
            },
        ),
        migrations.RunPython(seed_plan_part_map, reverse_code=migrations.RunPython.noop),
    ]
