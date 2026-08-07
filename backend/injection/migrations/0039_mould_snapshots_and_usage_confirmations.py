from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ('injection', '0038_injectionmonitoringrollup'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='MouldDataSnapshot',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('snapshot_key', models.CharField(max_length=96, unique=True, verbose_name='스냅샷 키')),
                ('kind', models.CharField(choices=[('board', '금형 현황'), ('detail', '금형 상세')], db_index=True, max_length=16, verbose_name='구분')),
                ('instance_id', models.CharField(blank=True, db_index=True, max_length=32, verbose_name='BLACKLAKE 인스턴스 ID')),
                ('payload', models.JSONField(default=dict, verbose_name='공개용 스냅샷')),
                ('source_latest_at', models.DateTimeField(blank=True, null=True, verbose_name='원본 최신 시각')),
                ('refreshed_at', models.DateTimeField(auto_now=True, db_index=True, verbose_name='수집 시각')),
                ('refresh_started_at', models.DateTimeField(blank=True, null=True, verbose_name='갱신 시작 시각')),
                ('last_error', models.CharField(blank=True, max_length=500, verbose_name='최근 갱신 오류')),
            ],
            options={
                'verbose_name': '금형 데이터 스냅샷',
                'verbose_name_plural': '금형 데이터 스냅샷',
            },
        ),
        migrations.CreateModel(
            name='MouldUsageConfirmation',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('mould_instance_id', models.CharField(db_index=True, max_length=32, verbose_name='BLACKLAKE 인스턴스 ID')),
                ('milestone_shots', models.PositiveIntegerField(verbose_name='확인 형합수')),
                ('shot_count_at_confirmation', models.PositiveIntegerField(verbose_name='확인 당시 형합수')),
                ('confirmed_at', models.DateTimeField(auto_now_add=True, db_index=True, verbose_name='확인 시각')),
                ('note', models.CharField(blank=True, max_length=240, verbose_name='비고')),
                ('confirmed_by', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='mould_usage_confirmations', to=settings.AUTH_USER_MODEL, verbose_name='확인자')),
            ],
            options={
                'verbose_name': '금형 형합수 확인',
                'verbose_name_plural': '금형 형합수 확인',
                'ordering': ['-milestone_shots', '-confirmed_at'],
            },
        ),
        migrations.AddIndex(
            model_name='moulddatasnapshot',
            index=models.Index(fields=['kind', 'refreshed_at'], name='mould_snap_kind_time_idx'),
        ),
        migrations.AddIndex(
            model_name='mouldusageconfirmation',
            index=models.Index(fields=['mould_instance_id', 'milestone_shots'], name='mould_usage_instance_idx'),
        ),
        migrations.AddConstraint(
            model_name='mouldusageconfirmation',
            constraint=models.UniqueConstraint(fields=('mould_instance_id', 'milestone_shots'), name='uniq_mould_usage_milestone'),
        ),
    ]
