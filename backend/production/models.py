from django.db import models

class ProductionPlan(models.Model):
    """
    Stores a single production plan entry for a specific date, machine, and part.
    """
    plan_date = models.DateField(db_index=True)
    plan_type = models.CharField(max_length=20, db_index=True)  # 'injection' or 'machining'
    machine_name = models.CharField(max_length=100, db_index=True)
    lot_no = models.CharField(max_length=100, null=True, blank=True)
    model_name = models.CharField(max_length=100, null=True, blank=True, db_index=True)
    part_spec = models.CharField(max_length=100, null=True, blank=True)
    part_no = models.CharField(max_length=100, null=True, blank=True, db_index=True)  # Corresponds to fg_part_no
    planned_quantity = models.FloatField()
    sequence = models.IntegerField(default=-1) # To preserve order from upload
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # A plan for a given day, machine, and part should be unique.
        # Lot no is included for cases where the same part is planned with different lot numbers.
        unique_together = ('plan_date', 'machine_name', 'part_no', 'lot_no', 'plan_type', 'sequence')
        ordering = ['plan_date', 'machine_name', 'sequence']
        indexes = [
            models.Index(fields=['plan_date', 'plan_type']),
        ]

    def __str__(self):
        return f"{self.plan_date} - {self.machine_name} - {self.part_no} ({self.planned_quantity})"
