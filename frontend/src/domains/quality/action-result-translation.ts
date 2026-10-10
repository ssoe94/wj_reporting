export type ActionResultTranslationStatus = 'translated' | 'pending' | 'failed' | 'not_required';

export interface ActionResultTranslation {
  language: 'ko';
  text: string;
  status: ActionResultTranslationStatus;
  translated_at: string | null;
  model_name: string;
  prompt_version: string;
}

export function getActionResultDisplay(
  source: string | null | undefined,
  translation: ActionResultTranslation | null | undefined,
  lang: 'ko' | 'zh',
) {
  const original = source || '';
  const translated = lang === 'ko'
    && original.trim().length > 0
    && translation?.language === 'ko'
    && translation.status === 'translated'
    && translation.text.trim().length > 0;
  const status = lang === 'ko' && original.trim().length > 0 && !translated
    && (translation?.status === 'pending' || translation?.status === 'failed')
    ? translation.status : null;

  return {
    original,
    text: translated ? translation.text : original,
    translated,
    status,
  };
}

/** Translation is display-only. Updates must contain the editor's original text. */
export function actionResultSourceUpdate(sourceDraft: string) {
  return { action_result: sourceDraft };
}
