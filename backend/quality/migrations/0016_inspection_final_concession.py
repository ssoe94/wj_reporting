from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('quality', '0015_inspection_shared_terminal')]
    operations = [migrations.AlterField(model_name='inspectionrequest', name='judgement', field=models.CharField(max_length=16, blank=True, default=''))]
