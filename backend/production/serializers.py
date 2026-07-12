from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from rest_framework import serializers

from .models import (
    InjectionActivityConfirmation,
    InjectionDowntimeConfirmation,
    ProductionExecution,
    ProductionPlan,
    ProductionPlanChangeLog,
)
from .product_context import extract_plan_product_context


class ProductionPlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductionPlan
        fields = [
            'id',
            'plan_date',
            'plan_type',
            'machine_name',
            'lot_no',
            'model_name',
            'part_spec',
            'product_family_code',
            'product_family_name',
            'is_finished_product',
            'part_no',
            'planned_quantity',
            'sequence',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'plan_date', 'plan_type', 'created_at', 'updated_at']

    def validate(self, attrs):
        if 'part_spec' in attrs:
            attrs.update(extract_plan_product_context(attrs.get('part_spec')))
        return attrs

    def validate_planned_quantity(self, value):
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            raise serializers.ValidationError('Invalid planned quantity.')


class ProductionExecutionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductionExecution
        fields = [
            'id',
            'plan_date',
            'plan_type',
            'machine_name',
            'part_no',
            'lot_no',
            'sequence',
            'model_name',
            'actual_qty',
            'defect_qty',
            'idle_time',
            'personnel_count',
            'operating_ct',
            'start_datetime',
            'end_datetime',
            'note',
            'status',
            'updated_by',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'updated_by', 'created_at', 'updated_at']

    def validate_actual_qty(self, value):
        return max(0, int(value or 0))

    def validate_defect_qty(self, value):
        return max(0, int(value or 0))

    def validate_idle_time(self, value):
        return max(0, int(value or 0))

    def validate_personnel_count(self, value):
        return max(0, float(value or 0))


class ProductionPlanChangeLogSerializer(serializers.ModelSerializer):
    changed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = ProductionPlanChangeLog
        fields = [
            'id',
            'plan_date',
            'plan_type',
            'action',
            'machine_name',
            'part_no',
            'model_name',
            'lot_no',
            'plan_id',
            'before',
            'after',
            'summary',
            'changed_by_name',
            'created_at',
        ]

    def get_changed_by_name(self, obj):
        user = obj.changed_by
        if not user:
            return None
        return getattr(user, 'username', None) or getattr(user, 'email', None) or str(user)


class InjectionActivityConfirmationSerializer(serializers.ModelSerializer):
    confirmed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = InjectionActivityConfirmation
        fields = [
            'id',
            'business_date',
            'machine_key',
            'machine_label',
            'activity_type',
            'part_no',
            'model_name',
            'shot_count',
            'last_shot_at',
            'note',
            'confirmed_by_name',
            'confirmed_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'confirmed_by_name', 'confirmed_at', 'updated_at']

    def validate_machine_key(self, value):
        normalized = (value or '').strip()
        if not normalized or any(character not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for character in normalized):
            raise serializers.ValidationError('Invalid machine key.')
        return normalized

    def validate_shot_count(self, value):
        return max(0, int(value or 0))

    def validate(self, attrs):
        business_date = attrs.get('business_date')
        activity_type = attrs.get('activity_type')
        part_no = (attrs.get('part_no') or '').strip().upper()
        note = (attrs.get('note') or '').strip()
        last_shot_at = attrs.get('last_shot_at')

        if activity_type == 'production' and not part_no:
            raise serializers.ValidationError({'part_no': 'Part No. is required for production activity.'})
        if activity_type == 'other' and not note:
            raise serializers.ValidationError({'note': 'A note is required for other activity.'})
        if business_date and last_shot_at:
            business_tz = ZoneInfo('Asia/Shanghai')
            business_day_start = datetime.combine(business_date, time(hour=8), tzinfo=business_tz)
            business_day_end = business_day_start + timedelta(days=1)
            if not business_day_start <= last_shot_at.astimezone(business_tz) <= business_day_end:
                raise serializers.ValidationError({'last_shot_at': 'Last shot is outside the business day.'})

        attrs['part_no'] = part_no
        attrs['model_name'] = (attrs.get('model_name') or '').strip()
        attrs['note'] = note
        return attrs

    def get_confirmed_by_name(self, obj):
        user = obj.confirmed_by
        if not user:
            return None
        return getattr(user, 'username', None) or getattr(user, 'email', None) or str(user)


class InjectionDowntimeConfirmationSerializer(serializers.ModelSerializer):
    confirmed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = InjectionDowntimeConfirmation
        fields = [
            'id',
            'business_date',
            'event_key',
            'machine_key',
            'machine_label',
            'detected_type',
            'detected_start',
            'detected_end',
            'duration_minutes',
            'resolution',
            'reason_code',
            'note',
            'evidence',
            'confirmed_by_name',
            'confirmed_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'confirmed_by_name', 'confirmed_at', 'updated_at']

    def validate_event_key(self, value):
        normalized = (value or '').strip()
        if not normalized or any(character not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:_-' for character in normalized):
            raise serializers.ValidationError('Invalid event key.')
        return normalized

    def validate_evidence(self, value):
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError('Evidence must be an object.')
        return value

    def validate(self, attrs):
        business_date = attrs.get('business_date')
        event_key = attrs.get('event_key') or ''
        machine_key = (attrs.get('machine_key') or '').strip()
        detected_start = attrs.get('detected_start')
        detected_end = attrs.get('detected_end')
        if business_date and event_key and not event_key.startswith(f'{business_date.isoformat()}:{machine_key}:'):
            raise serializers.ValidationError({'event_key': 'Event key does not match the business date or machine.'})

        if business_date and detected_start:
            business_tz = ZoneInfo('Asia/Shanghai')
            business_day_start = datetime.combine(business_date, time(hour=8), tzinfo=business_tz)
            business_day_end = business_day_start + timedelta(days=1)
            if not business_day_start <= detected_start.astimezone(business_tz) < business_day_end:
                raise serializers.ValidationError({'detected_start': 'Detected start is outside the business day.'})

        if detected_start and detected_end:
            if detected_end < detected_start:
                raise serializers.ValidationError({'detected_end': 'End time must be after start time.'})
            if business_date and detected_end.astimezone(ZoneInfo('Asia/Shanghai')) > business_day_end:
                raise serializers.ValidationError({'detected_end': 'Detected end is outside the business day.'})
            attrs['duration_minutes'] = max(0, round((detected_end - detected_start).total_seconds() / 60))

        resolution = attrs.get('resolution')
        reason_code = attrs.get('reason_code')
        note = (attrs.get('note') or '').strip()
        if resolution == 'dismissed':
            attrs['reason_code'] = 'not_stop'
        elif not reason_code or reason_code == 'not_stop':
            raise serializers.ValidationError({'reason_code': 'A downtime reason is required.'})
        if attrs.get('reason_code') == 'other' and not note:
            raise serializers.ValidationError({'note': 'A note is required for the other reason.'})
        attrs['note'] = note
        return attrs

    def get_confirmed_by_name(self, obj):
        user = obj.confirmed_by
        if not user:
            return None
        return getattr(user, 'username', None) or getattr(user, 'email', None) or str(user)
