import { inspectionDisplayLabel } from './displayLabel';
import type { ReactNode } from 'react';
import type { InspectionItem, InspectionMeasurement } from './model';
import type { InspectionArea } from './roleModel';
import { inspectionMeasurementJudgement } from './measurementJudgement';

export default function InspectionMeasurementVerdict({ item, area, value, recordedJudgement, lang, children }: {
  item: InspectionItem; area: InspectionArea; value: string; recordedJudgement?: InspectionMeasurement['judgement']; lang: 'ko' | 'zh'; children: ReactNode;
}) {
  const verdict = inspectionMeasurementJudgement(item, area, value);
  if (!verdict.automatic) return <>{children}</>;
  const text = lang === 'ko' ? { pass: '합격', fail: '불합격', empty: '입력 대기', invalid: '값 확인', unconfigured: '기준 확인', below: '하한 미달', above: '상한 초과', recorded: '저장 판정' } : { pass: '合格', fail: '不合格', empty: '待填写', invalid: '检查数值', unconfigured: '检查标准', below: '低于下限', above: '超过上限', recorded: '已记录判定' };
  const delta = verdict.side ? `${text[verdict.side]} ${verdict.approximate ? '≈' : ''}${verdict.difference}${item.unit ? ` ${item.unit}` : ''}` : '';
  const mismatch = recordedJudgement && verdict.judgement && recordedJudgement !== verdict.judgement;
  return <span className="inspection-auto-verdict" role="status" aria-label={`${inspectionDisplayLabel(item.label, lang)} · ${text[verdict.state as Exclude<typeof verdict.state, 'manual'>]}${delta ? ` · ${delta}` : ''}`}>
    <span className="inspection-verdict-badge" data-verdict={verdict.state}>{text[verdict.state as Exclude<typeof verdict.state, 'manual'>]}</span>
    {delta && <span className="inspection-verdict-difference" title={verdict.exactDifference ? `${text[verdict.side!]} ${verdict.exactDifference} ${item.unit}` : undefined}>{delta}</span>}
    {mismatch && <span className="inspection-verdict-recorded">{text.recorded}: {text[recordedJudgement]}</span>}
  </span>;
}
