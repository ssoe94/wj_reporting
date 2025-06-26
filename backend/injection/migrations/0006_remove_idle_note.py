from django.db import migrations

class Migration(migrations.Migration):
    dependencies = [
        ('injection', '0005_add_part_and_idle_note'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='injectionreport',
            name='idle_note',
        ),
    ] 