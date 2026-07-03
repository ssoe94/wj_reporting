from django.db import migrations


SPECIAL_GROUP = "AAN30078443+AAN30078444"
SPECIAL_PARTS = {"AAN30078443", "AAN30078444"}


def reset_default_cavities(apps, schema_editor):
    ProductionPartCavity = apps.get_model("production", "ProductionPartCavity")

    for row in ProductionPartCavity.objects.all():
        part_no = (row.part_no or "").strip().upper()
        if part_no in SPECIAL_PARTS:
            row.cavity = 2
            row.cavity_pattern = "2x2"
            row.parts_per_shot = 2
            row.cavity_group = SPECIAL_GROUP
        else:
            row.cavity = 1
            row.cavity_pattern = "1x1"
            row.parts_per_shot = 1
            row.cavity_group = part_no
        row.save(update_fields=["cavity", "cavity_pattern", "parts_per_shot", "cavity_group"])


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("production", "0011_part_cavity_group"),
    ]

    operations = [
        migrations.RunPython(reset_default_cavities, noop_reverse),
    ]
