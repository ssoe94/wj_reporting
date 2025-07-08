from django.db import migrations, models

class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0007_alter_section_field'),
    ]

    operations = [
        migrations.CreateModel(
            name='EngineeringChangeOrder',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('form_type', models.CharField(choices=[('REGULAR', 'REGULAR'), ('TEMP', 'TEMP')], default='REGULAR', max_length=10, verbose_name='양식 구분')),
                ('eco_no', models.CharField(max_length=50, unique=True, verbose_name='ECO 번호')),
                ('eco_model', models.CharField(blank=True, max_length=100, verbose_name='모델')),
                ('customer', models.CharField(blank=True, max_length=100, verbose_name='고객사')),
                ('prepared_date', models.DateField(blank=True, null=True, verbose_name='제정일')),
                ('issued_date', models.DateField(blank=True, null=True, verbose_name='발표일')),
                ('received_date', models.DateField(blank=True, null=True, verbose_name='접수일')),
                ('due_date', models.DateField(blank=True, null=True, verbose_name='완료 예정일')),
                ('close_date', models.DateField(blank=True, null=True, verbose_name='완료일')),
                ('change_reason', models.TextField(blank=True, verbose_name='변경 사유')),
                ('change_details', models.TextField(blank=True, verbose_name='변경 내용')),
                ('applicable_work_order', models.CharField(blank=True, max_length=200, verbose_name='적용 작업지시/시점')),
                ('storage_action', models.CharField(blank=True, max_length=200, verbose_name='재고 처리')),
                ('inventory_finished', models.IntegerField(blank=True, null=True, verbose_name='완제품 재고')),
                ('inventory_material', models.IntegerField(blank=True, null=True, verbose_name='자재 재고')),
                ('applicable_date', models.DateField(blank=True, null=True, verbose_name='적용일')),
                ('status', models.CharField(choices=[('OPEN', 'OPEN'), ('WIP', 'WIP'), ('CLOSED', 'CLOSED')], default='OPEN', max_length=10, verbose_name='상태')),
                ('note', models.TextField(blank=True, verbose_name='비고')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={'verbose_name': 'ECO', 'verbose_name_plural': 'ECO 목록', 'ordering': ['-prepared_date', 'eco_no']},
        ),
    ] 