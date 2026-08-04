from rest_framework import serializers

from production.ai_types import PRODUCTION_AI_MODEL_IDS

from .models import AiJob


class AiJobSerializer(serializers.ModelSerializer):
    created_by_name = serializers.SerializerMethodField()

    class Meta:
        model = AiJob
        fields = [
            'id',
            'job_type',
            'status',
            'scope',
            'input_payload',
            'result_payload',
            'error_message',
            'claimed_by',
            'claimed_at',
            'started_at',
            'completed_at',
            'model_name',
            'prompt_version',
            'created_by',
            'created_by_name',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'status',
            'input_payload',
            'result_payload',
            'error_message',
            'claimed_by',
            'claimed_at',
            'started_at',
            'completed_at',
            'model_name',
            'prompt_version',
            'created_by',
            'created_by_name',
            'created_at',
            'updated_at',
        ]

    def get_created_by_name(self, obj):
        user = obj.created_by
        if not user:
            return None
        return getattr(user, 'username', None) or getattr(user, 'email', None) or str(user)


class AiJobResultSerializer(serializers.ModelSerializer):
    """Small, read-only payload for dashboard status/result polling."""

    class Meta:
        model = AiJob
        fields = [
            'id',
            'job_type',
            'status',
            'scope',
            'result_payload',
            'error_message',
            'claimed_by',
            'claimed_at',
            'started_at',
            'completed_at',
            'model_name',
            'prompt_version',
            'created_at',
            'updated_at',
        ]


class AiJobCreateSerializer(serializers.Serializer):
    RESERVED_TRIGGERS = {'hourly', 'question', 'worker_heartbeat'}
    ALLOWED_SCOPE_FIELDS = {
        AiJob.JOB_TYPE_PRODUCTION_DAILY: {'date', 'language', 'trigger'},
        AiJob.JOB_TYPE_PRODUCTION_MACHINE: {'date', 'language', 'machine', 'trigger'},
    }

    job_type = serializers.ChoiceField(choices=[
        AiJob.JOB_TYPE_PRODUCTION_DAILY,
        AiJob.JOB_TYPE_PRODUCTION_MACHINE,
    ])
    scope = serializers.JSONField(required=False)

    def validate_scope(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('scope must be an object.')
        return value

    def validate(self, attrs):
        job_type = attrs['job_type']
        scope = dict(attrs.get('scope') or {})
        trigger = str(scope.get('trigger') or '').strip()
        if trigger in self.RESERVED_TRIGGERS:
            raise serializers.ValidationError({
                'scope': f'{trigger} is a reserved AI job trigger.',
            })
        if trigger and trigger != 'manual':
            raise serializers.ValidationError({
                'scope': 'User-created AI jobs only support the manual trigger.',
            })

        allowed_fields = self.ALLOWED_SCOPE_FIELDS[job_type]
        unsupported_fields = sorted(set(scope) - allowed_fields)
        if unsupported_fields:
            raise serializers.ValidationError({
                'scope': f"Unsupported scope fields: {', '.join(unsupported_fields)}.",
            })

        machine = scope.get('machine')
        if machine is not None and not isinstance(machine, str):
            raise serializers.ValidationError({'scope': 'machine must be a string.'})
        if isinstance(machine, str) and len(machine.strip()) > 128:
            raise serializers.ValidationError({'scope': 'machine must be 128 characters or fewer.'})

        scope['trigger'] = 'manual'
        attrs['scope'] = scope
        return attrs

class AiJobClaimSerializer(serializers.Serializer):
    worker_name = serializers.CharField(max_length=128)
    worker_version = serializers.CharField(max_length=64)
    limit = serializers.IntegerField(required=False, min_value=1, max_value=10)
    job_types = serializers.ListField(
        child=serializers.ChoiceField(choices=[
            AiJob.JOB_TYPE_PRODUCTION_DAILY,
            AiJob.JOB_TYPE_PRODUCTION_MACHINE,
            AiJob.JOB_TYPE_QUALITY_IMAGE,
        ]),
        required=False,
        allow_empty=False,
    )


class AiJobCompleteSerializer(serializers.Serializer):
    result_payload = serializers.JSONField()
    model_name = serializers.CharField(max_length=128, required=False, allow_blank=True)
    prompt_version = serializers.CharField(max_length=64, required=False, allow_blank=True)

    def validate_result_payload(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('result_payload must be an object.')
        return value


class AiJobFailSerializer(serializers.Serializer):
    error_message = serializers.CharField(allow_blank=False)
    model_name = serializers.CharField(max_length=128, required=False, allow_blank=True)
    prompt_version = serializers.CharField(max_length=64, required=False, allow_blank=True)


class AiWorkerHeartbeatSerializer(serializers.Serializer):
    worker_name = serializers.CharField(max_length=128)
    llm_enabled = serializers.BooleanField(required=False, default=False)
    llm_ready = serializers.BooleanField(required=False, allow_null=True, default=None)
    model_name = serializers.CharField(max_length=128, required=False, allow_blank=True)
    worker_version = serializers.CharField(max_length=64, required=False, allow_blank=True)
    last_error = serializers.CharField(max_length=500, required=False, allow_blank=True)
    available_model_ids = serializers.ListField(
        child=serializers.ChoiceField(choices=PRODUCTION_AI_MODEL_IDS),
        required=False,
        allow_empty=True,
    )
