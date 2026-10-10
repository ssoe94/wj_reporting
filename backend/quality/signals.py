from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from .models import QualityImportAsset, QualityReport


@receiver(post_save, sender=QualityReport)
def schedule_action_result_translation(sender, instance, raw=False, update_fields=None, **kwargs):
    if raw or (update_fields is not None and 'action_result' not in update_fields):
        return
    from .action_result_translation import enqueue_after_commit, needs_translation
    if needs_translation(instance.action_result):
        transaction.on_commit(lambda report_id=instance.pk: enqueue_after_commit(report_id))


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
