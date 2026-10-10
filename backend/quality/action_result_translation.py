"""Server-owned translation identity, queueing, validation and publication."""
from __future__ import annotations

import hashlib
import logging
import re
from collections import Counter
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from ai_core.models import AiJob
from .models import QualityActionResultTranslation, QualityReport

PROMPT_VERSION = 'quality-action-result-ko-v3'
SCHEMA_VERSION = 'quality-action-result-translation.v1'
TRIGGER = 'quality_action_result_translation'
MODEL_ID = 'qwen38'
MAX_SOURCE_LENGTH = 6000
SHANGHAI_TZ = ZoneInfo('Asia/Shanghai')
logger = logging.getLogger(__name__)


def source_sha256(source):
    return hashlib.sha256(str(source or '').encode('utf-8')).hexdigest()


def needs_translation(source):
    return bool(re.search(r'[\u3400-\u9fff]', str(source or '')))


def protected_tokens(value):
    return Counter(re.findall(r'(?<![A-Za-z0-9])[-+−]?[A-Za-z0-9]+(?:[._/%:+-][A-Za-z0-9]+)*(?:[%％])?', value))


def next_daily_retry(now=None):
    local = (now or timezone.now()).astimezone(SHANGHAI_TZ)
    candidate = datetime.combine(local.date(), time(6), tzinfo=SHANGHAI_TZ)
    return candidate if local < candidate else candidate + timedelta(days=1)


def is_translation_job(job):
    return job.job_type == AiJob.JOB_TYPE_QUALITY_TRANSLATION


def enqueue_report_translation(report_id, *, retry=False):
    """Serialize on the source row: one current translation/job per report."""
    with transaction.atomic():
        report = QualityReport.objects.select_for_update().filter(pk=report_id).first()
        if report is None or not needs_translation(report.action_result):
            return None, False
        digest = source_sha256(report.action_result)
        cached, _ = QualityActionResultTranslation.objects.get_or_create(
            report=report, defaults={'source_sha256': digest, 'prompt_version': PROMPT_VERSION},
        )
        cached = QualityActionResultTranslation.objects.select_for_update(of=('self',)).select_related('job').get(pk=cached.pk)
        same_source = cached.source_sha256 == digest and cached.prompt_version == PROMPT_VERSION
        if same_source:
            if cached.text and cached.translated_at:
                return cached.job, False
            if cached.job and cached.job.status in {AiJob.STATUS_PENDING, AiJob.STATUS_CLAIMED, AiJob.STATUS_RUNNING}:
                return cached.job, False
            if cached.retry_after and (not retry or cached.retry_after > timezone.now()):
                return cached.job, False
        if len(report.action_result) > MAX_SOURCE_LENGTH:
            return None, False  # Never truncate the authoritative note.
        scope = {'report_id': report.pk, 'source_sha256': digest, 'language': 'ko',
                 'model_id': MODEL_ID, 'trigger': TRIGGER, 'prompt_version': PROMPT_VERSION,
                 'enqueue_reason': 'daily_catch_up' if retry else 'source_change'}
        job = AiJob.objects.create(
            job_type=AiJob.JOB_TYPE_QUALITY_TRANSLATION, scope=scope,
            input_payload={'schema_version': SCHEMA_VERSION, **scope, 'source_text': report.action_result},
        )
        cached.source_sha256 = digest
        cached.prompt_version = PROMPT_VERSION
        cached.text = ''
        cached.model_name = ''
        cached.translated_at = None
        cached.retry_after = None
        cached.job = job
        cached.save()
        return job, True


def enqueue_after_commit(report_id):
    try:
        enqueue_report_translation(report_id)
    except Exception:
        # Translation failure cannot interrupt source entry; daily scanning repairs it.
        logger.exception('Could not enqueue quality translation for report %s', report_id)


def enqueue_missing_translations(now=None, *, limit=30):
    """06:00 Shanghai catch-up; repeated polls drain bounded, duplicate-safe batches."""
    current = now or timezone.now()
    if current.astimezone(SHANGHAI_TZ).hour < 6:
        return {'created_count': 0, 'schedule': '06:00 Asia/Shanghai'}
    created = 0
    reports = QualityReport.objects.exclude(action_result='').select_related(
        'action_result_translation__job',
    ).only(
        'id', 'report_dt', 'action_result',
        'action_result_translation__id', 'action_result_translation__report_id',
        'action_result_translation__source_sha256', 'action_result_translation__prompt_version',
        'action_result_translation__text', 'action_result_translation__translated_at',
        'action_result_translation__retry_after', 'action_result_translation__job_id',
        'action_result_translation__job__id', 'action_result_translation__job__status',
    ).order_by('-report_dt', '-id')
    for report in reports.iterator(chunk_size=250):
        if not needs_translation(report.action_result):
            continue
        cached = getattr(report, 'action_result_translation', None)
        if cached and cached.source_sha256 == source_sha256(report.action_result) and cached.prompt_version == PROMPT_VERSION:
            if cached.text and cached.translated_at:
                continue
            if cached.job and cached.job.status in {AiJob.STATUS_PENDING, AiJob.STATUS_CLAIMED, AiJob.STATUS_RUNNING}:
                continue
            if cached.retry_after and cached.retry_after > current:
                continue
        _, was_created = enqueue_report_translation(report.pk, retry=True)
        created += int(was_created)
        if created >= limit:
            break
    return {'created_count': created, 'schedule': '06:00 Asia/Shanghai'}


def translation_representation(report):
    """Read-only: never seed a row or display a translation of stale text."""
    result = {'language': 'ko', 'text': '', 'status': 'not_required',
              'translated_at': None, 'model_name': '', 'prompt_version': ''}
    if not needs_translation(report.action_result):
        return result
    result['status'] = 'failed' if len(report.action_result) > MAX_SOURCE_LENGTH else 'pending'
    cached = getattr(report, 'action_result_translation', None)
    if not cached or cached.source_sha256 != source_sha256(report.action_result) or cached.prompt_version != PROMPT_VERSION:
        return result
    if cached.text and cached.translated_at:
        result.update(text=cached.text, status='translated', translated_at=cached.translated_at.isoformat(),
                      model_name=cached.model_name, prompt_version=cached.prompt_version)
    elif cached.job and cached.job.status == AiJob.STATUS_FAILED:
        result['status'] = 'failed'
    return result


def validate_candidate(source, candidate):
    if not isinstance(candidate, str) or not candidate.strip():
        raise ValidationError({'translation': 'Korean translation is required.'})
    text = candidate.strip()
    if len(text) > MAX_SOURCE_LENGTH * 2 or not re.search(r'[가-힣]', text):
        raise ValidationError({'translation': 'Translation is too long or does not contain Korean.'})
    if protected_tokens(source) != protected_tokens(text):
        raise ValidationError({'translation': 'Translation changed a code, number or unit.'})
    names = set(re.findall(r'(?:厂家|供应商|供方)\s*[:：]\s*([\u3400-\u9fff]{2,16})', source))
    if '紫金' in source:
        names.add('紫金')
    if any(source.count(name) != text.count(name) for name in names):
        raise ValidationError({'translation': 'Translation changed a company name.'})
    if not any(term in source for term in ('完成', '完毕', '완료')) and '완료' in text:
        raise ValidationError({'translation': 'Translation added an unsupported completion status.'})
    for original, translated in [('返工', '재작업'), ('报废', '폐기'), ('退货', '반품'),
                                 ('邀请', '요청'), ('全检', '전수'), ('入库', '입고'),
                                 ('出库', '출고'), ('擦拭', '닦')]:
        if original in source and translated not in text:
            raise ValidationError({'translation': 'Translation omitted a source action.'})
    return text


def accept_translation(job, candidate, *, prompt_version, model_name):
    payload = job.input_payload
    if (prompt_version != PROMPT_VERSION or payload.get('prompt_version') != PROMPT_VERSION
            or payload.get('schema_version') != SCHEMA_VERSION or job.scope.get('model_id') != MODEL_ID
            or candidate.get('schema_version') != SCHEMA_VERSION or candidate.get('language') != 'ko'
            or candidate.get('source') != 'local_qwen38_translation' or candidate.get('llm_fallback') is not False
            or candidate.get('source_sha256') != payload.get('source_sha256')):
        raise ValidationError({'translation': 'Unsupported translation contract.'})
    source = payload.get('source_text')
    if not isinstance(source, str) or source_sha256(source) != payload.get('source_sha256'):
        raise ValidationError({'translation': 'Invalid server source snapshot.'})
    text = validate_candidate(source, candidate.get('translation'))
    report = QualityReport.objects.select_for_update().filter(pk=payload.get('report_id')).first()
    result = {'schema_version': SCHEMA_VERSION, 'source': 'local_qwen38_translation',
              'language': 'ko', 'report_id': payload.get('report_id'), 'source_sha256': payload['source_sha256'],
              'accepted_translation': False, 'llm_fallback': False}
    if report is None or report.action_result != source:
        return {**result, 'reason': 'source_changed_or_deleted'}
    cached = QualityActionResultTranslation.objects.select_for_update().filter(report=report).first()
    if cached is None or cached.job_id != job.pk or cached.source_sha256 != payload['source_sha256']:
        return {**result, 'reason': 'superseded_translation'}
    cached.text = text
    cached.model_name = model_name
    cached.translated_at = timezone.now()
    cached.retry_after = None
    cached.save(update_fields=['text', 'model_name', 'translated_at', 'retry_after', 'updated_at'])
    return {**result, 'accepted_translation': True, 'translation': text}


def record_translation_failure(job):
    QualityActionResultTranslation.objects.filter(job_id=job.pk).update(retry_after=next_daily_retry())
