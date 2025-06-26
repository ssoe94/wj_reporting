from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [
        ('injection', '0004_partspec'),
    ]

    operations = [
        migrations.AddField(
            model_name='injectionreport',
            name='part_no',
            field=models.CharField(blank=True, max_length=100, verbose_name='Part No.'),
        ),
        migrations.AddField(
            model_name='injectionreport',
            name='idle_note',
            field=models.CharField(blank=True, max_length=200, verbose_name='부동시간 비고'),
        ),
    ] 