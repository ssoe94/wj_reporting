type PreviewRequirements = {
  hasFiles: boolean;
  hasSelectedMonths: boolean;
  unknownEmployment: boolean;
  parseFailed: boolean;
  incompleteDecision: boolean;
  issueCount: number;
  referenceReady: boolean;
  disabled: boolean;
  busy: boolean;
};

/** First blocker in display order. A null result allows validation. */
export function workbookPreviewBlocker({
  hasFiles, hasSelectedMonths, unknownEmployment, parseFailed, incompleteDecision,
  issueCount, referenceReady, disabled, busy,
}: PreviewRequirements) {
  if (busy) return 'busy';
  if (disabled) return 'disabled';
  if (!referenceReady) return 'reference';
  if (!hasFiles) return 'files';
  if (unknownEmployment) return 'employment';
  if (parseFailed) return 'parse';
  if (!hasSelectedMonths) return 'months';
  if (incompleteDecision) return 'decision';
  if (issueCount > 0) return 'issues';
  return null;
}
