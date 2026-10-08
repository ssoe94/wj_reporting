from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('mes_oauth', '0002_mescredential_mescredentialevent_mesloginsession_and_more')]
    operations = [
        migrations.AddField(model_name='mesloginsession', name='session_version', field=models.PositiveSmallIntegerField(null=True)),
        migrations.AddField(model_name='mesloginsession', name='last_activity_at', field=models.DateTimeField(null=True)),
        migrations.AddField(model_name='mesloginsession', name='idle_expires_at', field=models.DateTimeField(null=True)),
    ]
