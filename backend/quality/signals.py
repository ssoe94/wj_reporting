from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import QualityImportAsset


def _delete_file(field_file) -> None:
    if not field_file or not field_file.name:
        return
    try:
        field_file.storage.delete(field_file.name)
    except Exception:
        # The database audit remains authoritative. Storage cleanup can be
        # retried by operations without making a DB deletion fail midway.
        pass


@receiver(post_delete, sender=QualityImportAsset)
def delete_import_asset_file(sender, instance, **kwargs):
    """Only the content-addressed asset owns the stored image."""

    _delete_file(instance.file)
