from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('quality', '0008_quality_import_source_scope'),
    ]

    operations = [
        migrations.AddField(
            model_name='qualityreport',
            name='excel_import_key',
            field=models.CharField(
                blank=True,
                editable=False,
                max_length=64,
                null=True,
                unique=True,
            ),
        ),
        migrations.AddField(
            model_name='qualityreport',
            name='excel_source',
            field=models.JSONField(blank=True, default=dict, editable=False),
        ),
        migrations.AddField(
            model_name='qualityreport',
            name='image4',
            field=models.URLField(blank=True, max_length=500, null=True, verbose_name='불량 이미지 4'),
        ),
        migrations.AddField(
            model_name='qualityreport',
            name='image5',
            field=models.URLField(blank=True, max_length=500, null=True, verbose_name='불량 이미지 5'),
        ),
    ]
