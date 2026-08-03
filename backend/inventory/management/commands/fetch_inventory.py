import datetime
import hashlib
import json
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from inventory.mes import _safe_exception_message, call_inventory_list
from inventory.models import StagingInventory
from inventory.services.raw_material_storage import save_mes_dataset


PAGE_SIZE = 100
MAX_PAGES = 500
PROGRESS_CACHE_KEY = "inventory_fetch_progress"
PROGRESS_CACHE_TTL = 600
SHANGHAI = ZoneInfo("Asia/Shanghai")
BUSINESS_DAY_START_HOUR = 8
QUANTITY_QUANTUM = Decimal("0.0001")
MAX_QUANTITY_ABS = Decimal("10000000000000000")


class Command(BaseCommand):
    help = "Fetch the complete MES inventory and atomically replace staging data"

    def add_arguments(self, parser):
        # Kept for compatibility with existing scheduled invocations. The command
        # performs a full synchronization and intentionally has no time filter.
        parser.add_argument(
            "--hours",
            type=int,
            default=2,
            help="Lookback hours (retained for backwards compatibility)",
        )
        parser.add_argument(
            "--allow-empty",
            action="store_true",
            help="Allow an empty MES result to replace an existing staging snapshot",
        )
        parser.add_argument(
            "--pending-dataset",
            action="store_true",
            help="Store inventory as an unpromoted dataset for the raw-material sync",
        )
        parser.add_argument(
            "--capture-type",
            choices=("daily", "manual"),
            default="daily",
            help="Label the dataset as the scheduled 08:00 or a manual capture",
        )

    def handle(self, *args, **options):
        page = 1
        pending_rows = []
        pending_objects = []
        seen_pages = set()
        authoritative_total = None

        self.stdout.write(
            "Full synchronization with MES (credential values are not logged)..."
        )
        self._set_progress(current=0, total=0, status="initializing")

        try:
            while True:
                items, staging_objects, page_total = self._fetch_and_validate_page(page)
                if page_total is not None:
                    if authoritative_total is None:
                        authoritative_total = page_total
                    elif authoritative_total != page_total:
                        raise RuntimeError(
                            "MES inventory total changed during pagination; the snapshot was not replaced"
                        )
                fingerprint = hashlib.sha256(
                    json.dumps(
                        items,
                        sort_keys=True,
                        separators=(",", ":"),
                        default=str,
                    ).encode("utf-8")
                ).hexdigest()
                if items and fingerprint in seen_pages:
                    raise RuntimeError(
                        f"Page {page} repeated an earlier MES page; stopped to limit upstream load"
                    )
                seen_pages.add(fingerprint)
                pending_rows.extend(items)
                pending_objects.extend(staging_objects)
                fetched_count = len(pending_objects)

                self.stdout.write(
                    f"Page {page}: validated {len(staging_objects)} items "
                    f"(total: {fetched_count})"
                )
                self._set_progress(
                    current=fetched_count,
                    total=fetched_count,
                    status="fetching",
                    page=page,
                )

                if authoritative_total is not None:
                    if fetched_count > authoritative_total:
                        raise RuntimeError(
                            "MES returned more inventory rows than its declared total"
                        )
                    if fetched_count == authoritative_total:
                        break
                if len(items) < PAGE_SIZE:
                    if (
                        authoritative_total is not None
                        and fetched_count < authoritative_total
                    ):
                        raise RuntimeError(
                            "MES pagination ended before the declared inventory total was received"
                        )
                    break
                if page >= MAX_PAGES:
                    raise RuntimeError(
                        f"Inventory pagination reached the {MAX_PAGES}-page safety limit"
                    )
                page += 1

            source_latest_at = max(
                (item.updated_at for item in pending_objects),
                default=None,
            )
            if (
                not pending_rows
                and StagingInventory.objects.exists()
                and not options["allow_empty"]
            ):
                raise RuntimeError(
                    "MES returned zero inventory rows; the existing snapshot was preserved"
                )
            snapshot_date = (
                timezone.now().astimezone(SHANGHAI)
                - datetime.timedelta(hours=BUSINESS_DAY_START_HOUR)
            ).date()

            # Both representations describe the same successful MES fetch. Keep
            # them in one outer transaction so neither can advance independently.
            with transaction.atomic():
                save_mes_dataset(
                    kind=(
                        "inventory_pending"
                        if options["pending_dataset"]
                        else "inventory"
                    ),
                    rows=pending_rows,
                    snapshot_date=snapshot_date,
                    source_latest_at=source_latest_at,
                    capture_type=options["capture_type"],
                )
                StagingInventory.objects.all().delete()
                StagingInventory.objects.bulk_create(
                    pending_objects,
                    batch_size=1000,
                )
        except Exception as exc:
            safe_error = _safe_exception_message(exc)
            fetched_count = len(pending_objects)
            self._set_progress(
                current=fetched_count,
                total=fetched_count,
                status="error",
                error=safe_error,
            )
            self.stdout.write(
                self.style.ERROR(f"Inventory synchronization failed: {safe_error}")
            )
            raise CommandError(
                f"Inventory synchronization failed: {safe_error}"
            ) from None

        imported_count = len(pending_objects)
        self._set_progress(
            current=imported_count,
            total=imported_count,
            status="completed",
        )
        self.stdout.write(
            self.style.SUCCESS(
                f"Imported {imported_count} rows to staging inventory"
            )
        )

    def _fetch_and_validate_page(self, page):
        # call_inventory_list owns the bounded HTTP retry policy.  Retrying the
        # whole call here as well would multiply MES traffic during an outage.
        try:
            response = call_inventory_list(page=page, size=PAGE_SIZE)
            items = self._extract_items(response, page)
            staging_objects = [
                self._build_staging_object(item, page, index)
                for index, item in enumerate(items, start=1)
            ]
            raw_total = None
            data = response.get("data") if isinstance(response, dict) else None
            if isinstance(data, dict) and "total" in data:
                raw_total = data.get("total")
            elif isinstance(response, dict):
                raw_total = response.get("total")
            try:
                parsed_total = int(raw_total) if raw_total is not None else None
            except (TypeError, ValueError):
                raise ValueError(f"Page {page} returned an invalid inventory total") from None
            authoritative_total = (
                parsed_total if parsed_total is not None and parsed_total > 0 else None
            )
            return items, staging_objects, authoritative_total
        except Exception as exc:
            safe_error = _safe_exception_message(exc)
            raise RuntimeError(f"Page {page} failed: {safe_error}") from None

    @staticmethod
    def _extract_items(response, page):
        if not isinstance(response, dict) or not response:
            raise ValueError(f"Page {page} returned an empty or invalid MES response")
        if "code" in response and response.get("code") != 200:
            raise ValueError(f"Page {page} returned an unsuccessful MES status")

        data = response.get("data")
        nested_items = data.get("list") if isinstance(data, dict) else None

        # Preserve the legacy top-level `items` fallback, including when an empty
        # nested list is accompanied by a populated fallback list.
        if isinstance(nested_items, list) and nested_items:
            items = nested_items
        elif "items" in response:
            items = response.get("items")
        elif isinstance(data, dict) and "list" in data:
            items = nested_items
        else:
            raise ValueError(f"Page {page} did not include an inventory list")

        if not isinstance(items, list):
            raise ValueError(f"Page {page} inventory list is not an array")
        return items

    @classmethod
    def _build_staging_object(cls, item, page, index):
        if not isinstance(item, dict):
            raise ValueError(f"Page {page} item {index} is not an object")

        try:
            material = cls._optional_mapping(item, "material")
            storage_detail = cls._optional_mapping(item, "storageLocationDetail")
            warehouse = cls._optional_mapping(storage_detail, "warehouse")
            location = cls._optional_mapping(storage_detail, "location")
            amount = cls._optional_mapping(item, "amount")
            unit = cls._optional_mapping(amount, "unit")
            storage_status = cls._optional_mapping(item, "storageStatus")
            qc_status = cls._optional_mapping(item, "qcStatus")

            work_orders = item.get("workOrderSimpleInfos") or [{}]
            if not isinstance(work_orders, list) or not work_orders:
                work_orders = [{}]
            if not isinstance(work_orders[0], dict):
                raise TypeError("workOrderSimpleInfos must contain objects")

            material_code = item.get("materialCode") or material.get("code")
            if not material_code:
                raise ValueError("material code is required")

            material_id = item.get("materialId") or material.get("id")
            trolley_code = item.get("trolleyCode") or item.get("labelCode") or ""
            updated_at = datetime.datetime.fromtimestamp(
                item.get("updatedAt") / 1000,
                tz=datetime.timezone.utc,
            )

            staging_object = StagingInventory(
                material_id=material_id,
                qr_code=item.get("qrCode") or "",
                label_code=trolley_code,
                composite_key=f"{trolley_code}::{material_code}",
                material_code=material_code,
                material_name=item.get("materialName") or material.get("name", ""),
                specification=material.get("specification", ""),
                biz_type=str(material.get("bizType", "")),
                warehouse_code=item.get("warehouseCode")
                or warehouse.get("code", ""),
                warehouse_name=item.get("warehouseName")
                or warehouse.get("name", ""),
                location_name=location.get("name", ""),
                storage_status=str(storage_status.get("code", "")),
                qc_status=str(qc_status.get("code", "")),
                work_order_code=work_orders[0].get("code", ""),
                quantity=cls._normalise_quantity(amount.get("amount", 0)),
                unit=unit.get("code", ""),
                updated_at=updated_at,
            )
        except (AttributeError, KeyError, OSError, OverflowError, TypeError, ValueError):
            # Do not include the original row or field values in command output.
            raise ValueError(f"Page {page} item {index} is malformed") from None

        try:
            staging_object.full_clean(
                validate_unique=False,
                validate_constraints=False,
            )
        except ValidationError as exc:
            if hasattr(exc, "message_dict"):
                fields = ", ".join(sorted(exc.message_dict))
            else:
                fields = "record"
            raise ValueError(
                f"Page {page} item {index} has invalid fields: {fields}"
            ) from None

        return staging_object

    @staticmethod
    def _normalise_quantity(value):
        """Convert MES JSON numbers without carrying binary float noise."""
        if value is None or isinstance(value, bool):
            raise ValueError("quantity must be a finite number")
        text = str(value).strip()
        if not text:
            raise ValueError("quantity must be a finite number")
        try:
            quantity = Decimal(text)
        except (InvalidOperation, TypeError, ValueError):
            raise ValueError("quantity must be a finite number") from None
        if not quantity.is_finite():
            raise ValueError("quantity must be a finite number")
        try:
            quantity = quantity.quantize(
                QUANTITY_QUANTUM,
                rounding=ROUND_HALF_UP,
            )
        except InvalidOperation:
            raise ValueError("quantity exceeds the supported precision") from None
        if quantity.copy_abs() >= MAX_QUANTITY_ABS:
            raise ValueError("quantity exceeds the supported precision")
        return quantity

    @staticmethod
    def _optional_mapping(container, key):
        value = container.get(key, {})
        if not isinstance(value, dict):
            raise TypeError(f"{key} must be an object")
        return value

    @staticmethod
    def _set_progress(**values):
        cache.set(PROGRESS_CACHE_KEY, values, PROGRESS_CACHE_TTL)
