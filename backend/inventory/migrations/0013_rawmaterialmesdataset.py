from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("inventory", "0012_finishedgoodstransaction"),
    ]

    operations = [
        migrations.CreateModel(
            name="RawMaterialSyncState",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("idle", "Idle"),
                            ("running", "Running"),
                            ("completed", "Completed"),
                            ("failed", "Failed"),
                        ],
                        default="idle",
                        max_length=16,
                    ),
                ),
                (
                    "trigger",
                    models.CharField(
                        choices=[("manual", "Manual"), ("daily", "Daily")],
                        default="manual",
                        max_length=16,
                    ),
                ),
                ("message", models.TextField(blank=True, default="")),
                ("started_at", models.DateTimeField(blank=True, null=True)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Raw-material MES sync state",
                "verbose_name_plural": "Raw-material MES sync state",
            },
        ),
        migrations.CreateModel(
            name="RawMaterialMESDataset",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("inventory", "Inventory detail"),
                            ("inventory_pending", "Pending inventory detail"),
                            ("change", "Inventory change log"),
                        ],
                        max_length=24,
                    ),
                ),
                (
                    "capture_type",
                    models.CharField(
                        choices=[
                            ("daily", "Daily 08:00"),
                            ("manual", "Manual"),
                        ],
                        default="daily",
                        max_length=16,
                    ),
                ),
                ("scope_key", models.CharField(max_length=64)),
                (
                    "warehouse_codes",
                    models.JSONField(blank=True, default=list),
                ),
                (
                    "warehouse_ids",
                    models.JSONField(blank=True, default=list),
                ),
                ("lookback_days", models.PositiveIntegerField(default=0)),
                (
                    "snapshot_date",
                    models.DateField(blank=True, db_index=True, null=True),
                ),
                ("range_start", models.DateTimeField(blank=True, null=True)),
                ("range_end", models.DateTimeField(blank=True, null=True)),
                ("payload", models.JSONField(default=list)),
                ("record_count", models.PositiveIntegerField(default=0)),
                (
                    "source_latest_at",
                    models.DateTimeField(blank=True, null=True),
                ),
                ("refreshed_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["-refreshed_at", "-id"],
                "indexes": [
                    models.Index(
                        fields=["kind", "refreshed_at"],
                        name="raw_mes_kind_refresh_idx",
                    ),
                    models.Index(
                        fields=["kind", "lookback_days", "refreshed_at"],
                        name="raw_mes_kind_lookback_idx",
                    ),
                    models.Index(
                        fields=["kind", "snapshot_date", "refreshed_at"],
                        name="raw_mes_kind_snapshot_idx",
                    ),
                ],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("kind", "scope_key"),
                        name="raw_mes_kind_scope_uniq",
                    ),
                ],
            },
        ),
    ]
