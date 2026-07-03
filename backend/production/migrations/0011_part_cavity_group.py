from django.db import migrations, models


def populate_cavity_metadata(apps, schema_editor):
    ProductionPartCavity = apps.get_model("production", "ProductionPartCavity")

    for row in ProductionPartCavity.objects.all():
        cavity = max(1, int(row.cavity or 1))
        if not row.cavity_pattern or (row.cavity_pattern == "1x1" and cavity != 1):
            row.cavity_pattern = f"1x{cavity}"
        row.parts_per_shot = max(1, int(row.parts_per_shot or 1))
        row.cavity_group = (row.cavity_group or row.part_no or "").strip().upper()
        row.save(update_fields=["cavity_pattern", "parts_per_shot", "cavity_group"])

    special_group = "AAN30078443+AAN30078444"
    for part_no in ["AAN30078443", "AAN30078444"]:
        ProductionPartCavity.objects.update_or_create(
            part_no=part_no,
            defaults={
                "cavity": 2,
                "cavity_pattern": "2x2",
                "parts_per_shot": 2,
                "cavity_group": special_group,
            },
        )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("production", "0010_machiningmanualreport_machiningmanualreportdefect_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="productionpartcavity",
            name="cavity_pattern",
            field=models.CharField(default="1x1", max_length=20),
        ),
        migrations.AddField(
            model_name="productionpartcavity",
            name="parts_per_shot",
            field=models.PositiveSmallIntegerField(default=1),
        ),
        migrations.AddField(
            model_name="productionpartcavity",
            name="cavity_group",
            field=models.CharField(blank=True, db_index=True, default="", max_length=255),
        ),
        migrations.RunPython(populate_cavity_metadata, noop_reverse),
    ]
