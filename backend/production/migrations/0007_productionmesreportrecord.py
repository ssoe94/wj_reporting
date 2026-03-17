from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('production', '0006_productionexecution'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProductionMesReportRecord',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('report_record_detail_id', models.BigIntegerField(unique=True)),
                ('report_record_id', models.BigIntegerField(blank=True, db_index=True, null=True)),
                ('report_record_code', models.CharField(blank=True, max_length=100, null=True)),
                ('business_date', models.DateField(db_index=True)),
                ('plan_type', models.CharField(db_index=True, max_length=20)),
                ('process_code', models.CharField(db_index=True, max_length=20)),
                ('report_time', models.DateTimeField(db_index=True)),
                ('equipment_name', models.CharField(blank=True, default='', max_length=200)),
                ('equipment_key', models.CharField(db_index=True, max_length=50)),
                ('part_no', models.CharField(db_index=True, max_length=100)),
                ('material_name', models.CharField(blank=True, default='', max_length=200)),
                ('report_qty', models.IntegerField(default=0)),
                ('raw_payload', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'ordering': ['business_date', 'plan_type', 'equipment_key', 'part_no', 'report_time'],
                'indexes': [
                    models.Index(fields=['business_date', 'plan_type'], name='production__busine_9aa955_idx'),
                    models.Index(fields=['business_date', 'equipment_key', 'part_no'], name='production__busine_7f65d3_idx'),
                    models.Index(fields=['report_time'], name='production__report__64aafe_idx'),
                ],
            },
        ),
    ]
