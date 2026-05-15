from django.db import migrations, models
import re


PRODUCT_FAMILY_MAP = {
    "B/C": ("BC", "Back cover"),
    "C/A": ("CA", "Cabinet"),
    "G/P": ("GP", "Guide Panel"),
}


def extract_context(part_spec):
    text = "" if part_spec is None else str(part_spec).strip()
    compact = re.sub(r"\s+", "", text).upper()
    is_finished_product = "完" in compact
    family_code = None
    family_name = None

    for marker, (code, name) in PRODUCT_FAMILY_MAP.items():
        if marker in compact:
            family_code = code
            family_name = name
            break

    return family_code, family_name, is_finished_product


def backfill_product_context(apps, schema_editor):
    ProductionPlan = apps.get_model("production", "ProductionPlan")
    rows = []
    for plan in ProductionPlan.objects.all().only("id", "part_spec"):
        family_code, family_name, is_finished_product = extract_context(plan.part_spec)
        plan.product_family_code = family_code
        plan.product_family_name = family_name
        plan.is_finished_product = is_finished_product
        rows.append(plan)

    if rows:
        ProductionPlan.objects.bulk_update(
            rows,
            ["product_family_code", "product_family_name", "is_finished_product"],
            batch_size=1000,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("production", "0007_productionmesreportrecord"),
    ]

    operations = [
        migrations.AddField(
            model_name="productionplan",
            name="product_family_code",
            field=models.CharField(blank=True, db_index=True, max_length=20, null=True),
        ),
        migrations.AddField(
            model_name="productionplan",
            name="product_family_name",
            field=models.CharField(blank=True, max_length=100, null=True),
        ),
        migrations.AddField(
            model_name="productionplan",
            name="is_finished_product",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.RunPython(backfill_product_context, migrations.RunPython.noop),
    ]
