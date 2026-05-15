from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("production", "0008_productionplan_product_context"),
    ]

    operations = [
        migrations.CreateModel(
            name="ProductionPlanChangeLog",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("plan_date", models.DateField(db_index=True)),
                ("plan_type", models.CharField(db_index=True, max_length=20)),
                ("action", models.CharField(choices=[("upload", "Upload"), ("create", "Create"), ("update", "Update"), ("reorder", "Reorder"), ("delete", "Delete")], db_index=True, max_length=20)),
                ("machine_name", models.CharField(blank=True, max_length=100, null=True)),
                ("part_no", models.CharField(blank=True, max_length=100, null=True)),
                ("model_name", models.CharField(blank=True, max_length=100, null=True)),
                ("lot_no", models.CharField(blank=True, max_length=100, null=True)),
                ("plan_id", models.IntegerField(blank=True, null=True)),
                ("before", models.JSONField(blank=True, default=dict)),
                ("after", models.JSONField(blank=True, default=dict)),
                ("summary", models.CharField(blank=True, default="", max_length=255)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("changed_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="production_plan_change_logs", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "ordering": ["-created_at", "-id"],
            },
        ),
        migrations.AddIndex(
            model_name="productionplanchangelog",
            index=models.Index(fields=["plan_date", "plan_type", "-created_at"], name="production__plan_da_295cf3_idx"),
        ),
    ]
