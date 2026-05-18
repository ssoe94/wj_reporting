from rest_framework import serializers

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


class AiJobCreateSerializer(serializers.Serializer):
    job_type = serializers.ChoiceField(choices=[
        AiJob.JOB_TYPE_PRODUCTION_DAILY,
        AiJob.JOB_TYPE_PRODUCTION_MACHINE,
    ])
    scope = serializers.JSONField(required=False)
    input_payload = serializers.JSONField(required=False)

    def validate_scope(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('scope must be an object.')
        return value

    def validate_input_payload(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('input_payload must be an object.')
        return value


class AiJobClaimSerializer(serializers.Serializer):
    worker_name = serializers.CharField(max_length=128)
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
