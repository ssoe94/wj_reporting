from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [
        ('injection', '0006_remove_idle_note'),
    ]

    operations = [
        migrations.AlterField(
            model_name='injectionreport',
            name='section',
            field=models.CharField(max_length=50, verbose_name='구분'),
        ),
    ] 