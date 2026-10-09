from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('mes_oauth', '0003_mesloginsession_activity')]

    operations = [
        migrations.AddField(
            model_name='mesloginticket', name='diagnostic_request_uid',
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.AddField(
            model_name='oauthattempt', name='diagnostic_request_uid',
            field=models.UUIDField(editable=False, null=True),
        ),
    ]
