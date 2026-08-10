from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0039_mould_snapshots_and_usage_confirmations'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='can_confirm_moulds',
            field=models.BooleanField(default=False, verbose_name='금형 확인·확정 권한'),
        ),
        migrations.AddField(
            model_name='userregistrationrequest',
            name='can_confirm_moulds',
            field=models.BooleanField(default=False, verbose_name='금형 확인·확정 권한'),
        ),
    ]
