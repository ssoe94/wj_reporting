import { Save } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { useLang } from '../../i18n';
import { getActionResultDisplay } from '../../domains/quality/action-result-translation';
import type { ActionResultTranslation } from '../../domains/quality/action-result-translation';

interface QualityActionResultProps {
  source?: string;
  translation?: ActionResultTranslation | null;
  editorId: string;
  contextLabel: string;
  canEdit: boolean;
  editing: boolean;
  sourceDraft: string;
  saving: boolean;
  disabled: boolean;
  onStartEditing: () => void;
  onSourceChange: (source: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export default function QualityActionResult({
  source, translation, editorId, contextLabel, canEdit, editing,
  sourceDraft, saving, disabled, onStartEditing, onSourceChange, onSave, onCancel,
}: QualityActionResultProps) {
  const { lang, t } = useLang();
  const display = getActionResultDisplay(source, translation, lang);
  const editLabel = lang === 'zh' ? '修改原文' : '원문 수정';

  return (
    <div className="min-w-0 space-y-2 text-left">
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800" lang={display.translated ? 'ko' : undefined}>
        {display.text || '-'}
      </p>
      {display.status && (
        <p className="text-xs leading-5 text-gray-500" role="status">
          {display.status === 'pending'
            ? '한국어 번역 대기 중'
            : '한국어 번역을 준비하지 못했습니다'}
        </p>
      )}
      {display.translated && (
        <details className="text-sm text-gray-600">
          <summary className="min-h-9 cursor-pointer py-1 text-xs leading-6 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            중국어 원문 보기
          </summary>
          <p className="mt-1 whitespace-pre-wrap break-words leading-6" lang="zh-CN">{display.original}</p>
        </details>
      )}
      {canEdit && !editing && (
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onStartEditing} className="px-2 text-xs">
          {editLabel}
        </Button>
      )}
      {canEdit && editing && (
        <div className="space-y-2">
          <label htmlFor={editorId} className="block text-xs font-medium text-gray-600">{editLabel}</label>
          <Textarea
            id={editorId}
            aria-label={`${editLabel} · ${contextLabel}`}
            rows={3}
            value={sourceDraft}
            disabled={saving}
            onChange={(event) => onSourceChange(event.target.value)}
            placeholder={t('quality.action_result_placeholder')}
            className="w-full min-w-0 resize-y text-base leading-6 xl:text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onSave} disabled={disabled} className="bg-indigo-600 px-2 text-xs text-white hover:bg-indigo-700">
              <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {saving ? t('saving') : t('quality.save_action')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onCancel} disabled={saving} className="px-2 text-xs">
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
