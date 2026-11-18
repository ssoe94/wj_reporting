"""Give the four finished-goods indexes the names their models derive.

Migration 0012 wrote these indexes with hand-made names that Django never
derives, so every ``makemigrations`` proposed renaming them. The state step
records that rename. The database step reads the table's actual indexes first:
it renames the 0012 index when present, keeps an index that already has the
derived name, and creates the index only when neither exists. A database
whose tables were not built by 0012 therefore still ends with exactly the
declared indexes instead of failing the deploy-time ``migrate``.
"""

from django.db import migrations, models


# (model, fields, name written by 0012, name derived from the model)
INDEXES = (
    ('finishedgoodstransactionsnapshot', ['slot', 'scheduled_at'],
     'inventory_f_slot_schedul_066a24_idx', 'inventory_f_slot_7a8270_idx'),
    ('finishedgoodstransactionsnapshot', ['report_date', 'slot'],
     'inventory_f_report__slot_c2ec0a_idx', 'inventory_f_report__e17885_idx'),
    ('finishedgoodstransaction', ['snapshot', 'material_code'],
     'inventory_f_snapshot_mate_f9ce6a_idx', 'inventory_f_snapsho_dac989_idx'),
    ('finishedgoodstransaction', ['material_code'],
     'inventory_f_material_code_d7c2ec_idx', 'inventory_f_materia_6f56ad_idx'),
)


def _index_names(schema_editor, table):
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(cursor, table)
    return {name for name, details in constraints.items() if details['index']}


def _align(apps, schema_editor, reverse):
    for model_name, fields, written, derived in INDEXES:
        model = apps.get_model('inventory', model_name)
        source, target = (derived, written) if reverse else (written, derived)
        existing = _index_names(schema_editor, model._meta.db_table)
        if target in existing:
            continue
        target_index = models.Index(fields=fields, name=target)
        if source in existing:
            schema_editor.rename_index(model, models.Index(fields=fields, name=source), target_index)
        else:
            schema_editor.add_index(model, target_index)


def forwards(apps, schema_editor):
    _align(apps, schema_editor, reverse=False)


def backwards(apps, schema_editor):
    _align(apps, schema_editor, reverse=True)


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0014_movement_history'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[migrations.RunPython(forwards, backwards)],
            state_operations=[
                migrations.RenameIndex(model_name=model_name, new_name=derived, old_name=written)
                for model_name, _fields, written, derived in INDEXES
            ],
        ),
    ]
