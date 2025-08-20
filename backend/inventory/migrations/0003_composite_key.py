from django.db import migrations, models


def populate_composite_key(apps, schema_editor):
    FactInventory = apps.get_model('inventory', 'FactInventory')
    for obj in FactInventory.objects.all():
        comp = f"{obj.qr_code}::{obj.material_code}"
        obj.composite_key = comp[:220]
        obj.save(update_fields=["composite_key"])


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0002_alter_staginginventory_qr_code'),
    ]

    operations = [
        # 1) add composite_key to StagingInventory
        migrations.AddField(
            model_name='staginginventory',
            name='composite_key',
            field=models.CharField(max_length=220, blank=True, default='', db_index=True),
        ),
        # 2) add composite_key to FactInventory (temp no unique)
        migrations.AddField(
            model_name='factinventory',
            name='composite_key',
            field=models.CharField(max_length=220, default=''),
        ),
        # 3) populate existing rows
        migrations.RunPython(populate_composite_key, noop),
        # 4) set unique constraint
        migrations.AlterField(
            model_name='factinventory',
            name='composite_key',
            field=models.CharField(max_length=220, unique=True),
        ),
    ]
