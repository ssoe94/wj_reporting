from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('inventory', '0011_unifiedpartspec'),
    ]

    operations = [
        migrations.CreateModel(
            name='FinishedGoodsTransactionSnapshot',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('slot', models.CharField(choices=[('morning', '오전 8시'), ('evening', '오후 8시')], db_index=True, max_length=16, verbose_name='집계 구간')),
                ('report_date', models.DateField(db_index=True, verbose_name='보고 일자')),
                ('scheduled_at', models.DateTimeField(db_index=True, verbose_name='기준 시각')),
                ('range_start', models.DateTimeField(verbose_name='집계 시작 시각')),
                ('range_end', models.DateTimeField(verbose_name='집계 종료 시각')),
                ('record_count', models.IntegerField(default=0, verbose_name='입출고 레코드 수')),
                ('total_in', models.DecimalField(decimal_places=4, default=0, max_digits=20, verbose_name='총 입고 수량')),
                ('total_out', models.DecimalField(decimal_places=4, default=0, max_digits=20, verbose_name='총 출고 수량')),
                ('net_change', models.DecimalField(decimal_places=4, default=0, max_digits=20, verbose_name='순 변동')),
                ('warehouse_filter', models.JSONField(blank=True, default=list, verbose_name='창고 필터')),
                ('metadata', models.JSONField(blank=True, default=dict, verbose_name='부가 정보')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'verbose_name': '완성품 입출고 스냅샷',
                'verbose_name_plural': '완성품 입출고 스냅샷',
                'ordering': ['-scheduled_at'],
                'unique_together': {('slot', 'report_date')},
                'indexes': [
                    models.Index(fields=['slot', 'scheduled_at'], name='inventory_f_slot_schedul_066a24_idx'),
                    models.Index(fields=['report_date', 'slot'], name='inventory_f_report__slot_c2ec0a_idx'),
                ],
            },
        ),
        migrations.CreateModel(
            name='FinishedGoodsTransaction',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('material_code', models.CharField(db_index=True, max_length=100, verbose_name='모델 코드')),
                ('material_name', models.CharField(blank=True, max_length=255, verbose_name='모델 명')),
                ('specification', models.CharField(blank=True, max_length=255, verbose_name='규격')),
                ('warehouse_code', models.CharField(blank=True, max_length=50, verbose_name='창고 코드')),
                ('warehouse_name', models.CharField(blank=True, max_length=255, verbose_name='창고 이름')),
                ('unit', models.CharField(blank=True, max_length=20, verbose_name='단위')),
                ('total_in', models.DecimalField(decimal_places=4, default=0, max_digits=20, verbose_name='입고 수량')),
                ('total_out', models.DecimalField(decimal_places=4, default=0, max_digits=20, verbose_name='출고 수량')),
                ('net_change', models.DecimalField(decimal_places=4, default=0, max_digits=20, verbose_name='순 변동')),
                ('record_count', models.IntegerField(default=0, verbose_name='레코드 수')),
                ('last_in_time', models.DateTimeField(blank=True, null=True, verbose_name='마지막 입고 시간')),
                ('last_out_time', models.DateTimeField(blank=True, null=True, verbose_name='마지막 출고 시간')),
                ('action_breakdown', models.JSONField(blank=True, default=dict, verbose_name='액션 집계')),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('snapshot', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='transactions', to='inventory.finishedgoodstransactionsnapshot', verbose_name='연결된 스냅샷')),
            ],
            options={
                'verbose_name': '완성품 입출고 집계',
                'verbose_name_plural': '완성품 입출고 집계',
                'ordering': ['material_code'],
                'indexes': [
                    models.Index(fields=['snapshot', 'material_code'], name='inventory_f_snapshot_mate_f9ce6a_idx'),
                    models.Index(fields=['material_code'], name='inventory_f_material_code_d7c2ec_idx'),
                ],
            },
        ),
    ]
