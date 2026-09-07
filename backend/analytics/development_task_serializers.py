"""Validated task documents. This endpoint never accepts SQL, MES writes or credentials."""
from urllib.parse import urlsplit

from rest_framework import serializers


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if isinstance(data, dict):
            unknown = set(data) - set(self.fields)
            if unknown:
                raise serializers.ValidationError({key: '지원하지 않는 필드입니다.' for key in sorted(unknown)})
        return super().to_internal_value(data)


class RequirementSerializer(StrictSerializer):
    id = serializers.SlugField(max_length=80)
    kind = serializers.ChoiceField(choices=['mes', 'human', 'decision'])
    text = serializers.CharField(max_length=2000)
    status = serializers.ChoiceField(choices=['needed', 'requested', 'ready'])
    evidence = serializers.CharField(max_length=4000, allow_blank=True)

    def validate(self, attrs):
        if attrs['status'] == 'ready' and not attrs['evidence']:
            raise serializers.ValidationError({'evidence': '확보한 자료 또는 확인 근거를 기록해 주세요.'})
        return attrs


class ChecklistSerializer(StrictSerializer):
    id = serializers.SlugField(max_length=80)
    text = serializers.CharField(max_length=2000)
    done = serializers.BooleanField()


class LocationSerializer(StrictSerializer):
    kind = serializers.ChoiceField(choices=['screen', 'code', 'doc'])
    url = serializers.CharField(max_length=2000)
    label = serializers.CharField(max_length=200)

    def validate(self, attrs):
        value = attrs['url']
        if any(char.isspace() or ord(char) < 32 for char in value) or '\\' in value:
            raise serializers.ValidationError({'url': '공백이나 역슬래시 없는 링크를 입력해 주세요.'})
        try:
            parsed = urlsplit(value)
        except ValueError:
            raise serializers.ValidationError({'url': '유효한 링크를 입력해 주세요.'})
        internal = value.startswith('/') and not value.startswith('//') and not parsed.netloc
        external = parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username and not parsed.password
        if not (internal or external) or (attrs['kind'] == 'screen' and not internal):
            raise serializers.ValidationError({'url': '화면은 /로 시작하는 내부 경로, 코드·문서는 내부 경로 또는 HTTPS 링크를 입력해 주세요.'})
        return attrs


class DevelopmentTaskInputSerializer(StrictSerializer):
    slug = serializers.RegexField(r'^[a-z0-9]+(?:[-_][a-z0-9]+)*$', max_length=100, required=False)
    title = serializers.CharField(max_length=200)
    title_zh = serializers.CharField(max_length=200, allow_blank=True)
    objective = serializers.CharField(max_length=6000)
    phase = serializers.IntegerField(min_value=0, max_value=5)
    priority = serializers.ChoiceField(choices=['P1', 'P2', 'P3'])
    status = serializers.ChoiceField(choices=['planned', 'in_progress', 'blocked', 'review', 'done'])
    owner = serializers.CharField(max_length=200, allow_blank=True)
    due_date = serializers.DateField(allow_null=True, default=None)
    dependencies = serializers.ListField(child=serializers.SlugField(max_length=100), max_length=30)
    requirements = RequirementSerializer(many=True, max_length=60)
    checklist = ChecklistSerializer(many=True, max_length=60)
    locations = LocationSerializer(many=True, max_length=30)
    completion_note = serializers.CharField(max_length=6000, allow_blank=True)
    verification_note = serializers.CharField(max_length=6000, allow_blank=True)
    release_state = serializers.ChoiceField(choices=['unreleased', 'code_available', 'deployed'])
    sort_order = serializers.IntegerField(min_value=0, max_value=10000)
    version = serializers.IntegerField(min_value=1, required=False)
    change_note = serializers.CharField(max_length=2000, required=False, allow_blank=True)

    def validate_slug(self, value):
        if value == 'initialize':
            raise serializers.ValidationError('기본 계획 등록에 사용되는 예약 ID입니다.')
        return value

    def validate(self, attrs):
        for name in ('requirements', 'checklist'):
            identifiers = [item['id'] for item in attrs[name]]
            if len(set(identifiers)) != len(identifiers):
                raise serializers.ValidationError({name: '항목 ID가 중복되었습니다.'})
        dependencies = attrs['dependencies']
        if len(set(dependencies)) != len(dependencies):
            raise serializers.ValidationError({'dependencies': '선행 과제가 중복되었습니다.'})
        if attrs['status'] == 'done':
            errors = {}
            if not attrs['checklist'] or not all(item['done'] for item in attrs['checklist']):
                errors['checklist'] = '완료 조건을 하나 이상 기록하고 모두 확인해 주세요.'
            if any(item['status'] != 'ready' for item in attrs['requirements']):
                errors['requirements'] = '자료·확인·결정 요청을 모두 해결한 뒤 완료해 주세요.'
            for key in ('completion_note', 'verification_note', 'owner'):
                if not attrs[key]:
                    errors[key] = '완료 처리에 필요한 기록입니다.'
            if not attrs['locations']:
                errors['locations'] = '구현 화면·코드 또는 확정 문서 위치를 하나 이상 기록해 주세요.'
            if errors:
                raise serializers.ValidationError(errors)
        return attrs
